# Feature Specification: Opened Document External Change

**Implementation Branch**: `feature-core` (this feature intentionally shares the integration branch; the Spec Kit feature pointer is `specs/005-opened-document-external-change`)

**Created**: 2026-09-19

**Status**: Ready for implementation

**Input**: Add external-change protection for opened, disk-bound documents without introducing Workspace tree watching. Clean documents follow external disk changes automatically; dirty documents must never be silently overwritten; externally deleted files remain open as recoverable in-memory documents. The watcher foundation must be reusable by the later Workspace watcher feature.

## Scope and Compatibility Contract

005 applies only to documents that already have a `DocumentSession` and are bound to a disk path. Untitled/unbound documents are outside the watch scope.

005 is intentionally independent of Workspace membership. A file opened from outside the current Workspace receives the same external-change protection as a file inside it.

005 MUST preserve the following previously established behavior:

- The existing `DocumentManager` remains the owner of document lifecycle and document state transitions.
- A `DocumentSession` keeps the same stable `documentId` while it remains the same open document.
- Existing Open / Save / Save As / Close / Rename / Delete ownership and path-identity rules remain authoritative unless this specification explicitly adds a pre-save external-change validation step.
- 003 Explorer behavior is NOT superseded: external filesystem changes are still not required to update the Workspace tree in real time. Explorer synchronization belongs to 006.
- Sorakada-initiated Delete keeps the existing 003 semantics. An external delete is different: 005 MUST keep the open tab and its in-memory content.
- 005 MUST NOT recognize an external rename/move as a move. A watched file that disappears from its bound path may safely become `missing`; path migration belongs to 006.
- 007 may later change visual presentation, but MUST preserve the document/disk behavior defined here.

## User Scenarios & Testing

### User Story 1 - Clean document follows external edits (Priority: P1)

A user has a saved, clean file open in Sorakada and edits the same file in another program. Sorakada updates the open document to the new disk contents automatically without asking the user to confirm a non-conflicting change.

**Why this priority**: A clean document has no Sorakada-only unsaved content. Keeping it synchronized with disk is the simplest and safest default and establishes the base external-change flow.

**Independent Test**: Open a saved file, leave it clean, modify and save it externally, and verify Sorakada reloads the new disk contents while the tab remains the same document and remains clean.

**Acceptance Scenarios**:

1. **Given** a clean open document bound to an existing file, **When** that file is modified externally, **Then** Sorakada automatically reloads the latest supported disk contents into the same document session and keeps the document clean.
2. **Given** a clean active document with a cursor/selection and scroll position, **When** an external change is auto-reloaded, **Then** Sorakada preserves each selection anchor/head as the same absolute text offset, clamped to the new document length. The editor restores a view that keeps the clamped primary selection head visible; exact pixel-for-pixel scroll position is not required when line layout changed.
3. **Given** a clean document with undo/redo history, **When** Sorakada reloads a different external disk version, **Then** the prior undo/redo history is cleared so undo cannot resurrect the superseded in-memory version.
4. **Given** a clean open document in a background tab, **When** it is modified externally, **Then** the background document can be reloaded without first activating the tab.
5. **Given** an open file outside the current Workspace, **When** it is modified externally, **Then** it receives the same automatic clean reload behavior as a Workspace-contained file.

---

### User Story 2 - Dirty document is protected from external divergence (Priority: P1)

A user has unsaved edits in Sorakada while another program changes the same file on disk. Sorakada preserves the user's unsaved buffer and prevents ordinary Save from silently overwriting the external version.

**Why this priority**: This is the primary data-safety requirement of 005. Incorrect handling can destroy either the user's unsaved work or another program's changes.

**Independent Test**: Make a document dirty, modify the same file externally, then attempt Save. Verify the Sorakada buffer is unchanged and Save requires an explicit overwrite decision.

**Acceptance Scenarios**:

1. **Given** a dirty open document, **When** its disk file is modified externally, **Then** Sorakada keeps the in-memory editor content unchanged and marks the document as externally modified.
2. **Given** a dirty externally modified document, **When** the user invokes ordinary Save, **Then** Sorakada blocks the normal save path and requires an explicit overwrite decision before writing.
3. **Given** a dirty externally modified document at the overwrite prompt, **When** the user chooses Cancel, **Then** neither the in-memory document nor the disk file is changed by Sorakada.
4. **Given** a dirty externally modified document at the overwrite prompt, **When** the user explicitly chooses Overwrite, **Then** Sorakada writes the current in-memory content, advances the saved baseline/revision only after successful completion, clears the external-modified state, and leaves the document clean.
5. **Given** a document that Sorakada believes has no external conflict, **When** the user invokes Save, **Then** Sorakada validates the current disk state immediately before committing the write so a previously missed external change is not silently overwritten.
6. **Given** a dirty externally modified document, **When** any reload-from-disk action is available and the user invokes it, **Then** Sorakada must explicitly confirm that the user's unsaved changes will be discarded before replacing the buffer.

---

### User Story 3 - Externally deleted file remains recoverable (Priority: P1)

A file that is open in Sorakada is removed by another program. Sorakada keeps the tab and the last in-memory contents instead of closing the document or losing data.

**Why this priority**: External deletion is not an explicit Sorakada user intent. Keeping the document open allows both clean and dirty buffers to be recovered safely.

**Independent Test**: Open a file, delete it outside Sorakada, and verify the tab/content remain. Invoke Save and verify the original path is recreated when its parent directory still exists.

**Acceptance Scenarios**:

1. **Given** a clean open document, **When** its bound file is deleted externally, **Then** Sorakada keeps the tab and contents and marks the document as missing.
2. **Given** a dirty open document, **When** its bound file is deleted externally, **Then** Sorakada keeps all unsaved content and marks the document as missing without changing dirty state.
3. **Given** a missing document whose parent directory still exists, including a clean missing document, **When** the user invokes Save, **Then** Save remains available and Sorakada recreates the file at the original path from the current in-memory content.
4. **Given** a missing document whose parent directory no longer exists, **When** the user invokes Save, **Then** Save fails without silently creating missing ancestor directories; the document remains open and recoverable for Save As.
5. **Given** a clean missing document, **When** a file appears again at the same bound path, **Then** Sorakada reloads that disk file and returns the document to normal clean state.
6. **Given** a dirty missing document, **When** a file appears again at the same bound path, **Then** Sorakada keeps the dirty in-memory content and treats the new disk file as an external modification rather than auto-reloading it.

---

### User Story 4 - Detection remains reliable without treating watcher events as truth (Priority: P2)

A user works normally while filesystem notifications are duplicated, coalesced, delayed, or missed. Sorakada still converges open-document state through validation on relevant user/application transitions, and its own file operations are not mistaken for external conflicts.

**Why this priority**: Filesystem watcher streams are hints rather than a durable source of truth. The feature must remain correct across common event irregularities and must establish infrastructure that 006 can reuse.

**Independent Test**: Simulate duplicated watcher events, missed events, Sorakada Save/Save As events, tab activation, and window focus regain. Verify the final document state is derived from disk validation and no false external conflict is created by Sorakada's own successful operation.

**Acceptance Scenarios**:

1. **Given** multiple filesystem notifications for the same path in a short interval, **When** they are processed, **Then** Sorakada may coalesce them but must converge to the current disk state without duplicate destructive transitions.
2. **Given** an external change whose realtime notification is missed, **When** the affected tab is activated or the Sorakada window regains focus, **Then** Sorakada revalidates relevant open disk-bound documents and can discover the divergence.
3. **Given** a Sorakada Save or Save As that causes filesystem notifications, **When** those notifications arrive, **Then** the operation's expected post-write state is reconciled and must not be reported as an external modification solely because Sorakada produced the events.
4. **Given** Sorakada is performing an internal filesystem mutation and an actual outside process also changes the same target, **When** the operation settles, **Then** Sorakada must not blindly suppress all notifications; a mismatching final disk state must still be surfaced as external divergence.
5. **Given** an opened document is closed or changes its bound path after Save As or an internal Explorer Rename, **When** the old path subsequently changes, **Then** the old watch interest no longer affects that document and the new bound path is monitored.

### Edge Cases

- A watcher reports a modification but the file's supported textual content/format is unchanged (for example, metadata-only touch): do not create a false content conflict after validation.
- A watcher reports a change while the file is temporarily unreadable or locked: preserve the current in-memory content, do not classify the file as missing solely from a read error, surface a non-destructive error state/message, and retry on a later validation trigger.
- A clean external reload changes file length so the previous selection/cursor offsets are invalid: clamp to valid positions rather than failing the reload.
- A clean external reload changes supported encoding/BOM/EOL information: the open document adopts the newly read disk format together with the new saved baseline.
- An externally changed file becomes unsupported/binary/undecodable under the existing text-file rules: do not replace the current editor content with a partial/invalid result; report the read/format failure and keep the previous in-memory state.
- A file is removed and recreated quickly at the same path: final behavior is based on validation of the current path and dirty state, not on assuming a specific raw event sequence.
- A file is externally renamed or moved: 005 may observe the original path as missing. It must not guess the new path using content, size, timestamps, or other heuristics.
- Multiple opened files share one parent directory: watching one file's change must not cause unrelated open documents to reload.
- Many opened files are distributed across unrelated directories: 005 may use multiple underlying watches; optimizing pathological hundreds-of-directories usage is not a requirement.
- A Save is requested immediately after an external event but before asynchronous event handling completes: the mandatory pre-save validation remains authoritative.
- A Save/Save As fails: `savedBaseline`, `diskRevision`, dirty state, external state, and bound path must not be advanced as though the write succeeded.
- A document is closed while a validation/reload operation is in flight: stale completion must not recreate or mutate the closed session.
- A document changes bound path while validation of the old path is in flight: stale completion for the old path must not mutate the newly bound session.
- A file changes after initial Open/Save As reads the disk but before its watcher subscription is fully established: registration must close this gap with a post-subscription validation so the session cannot remain silently stale.
- A missing document is being saved while another process recreates the target path before Sorakada commits the write: Sorakada must detect that the path is no longer missing and must not treat the write as an unconditional recreate.

## Requirements

### Functional Requirements

#### Watch Scope and Lifecycle

- **FR-001**: Sorakada MUST monitor every open `DocumentSession` that is currently bound to a disk path, regardless of Workspace membership.
- **FR-002**: Untitled/unbound documents MUST NOT create filesystem watch interest until they successfully become bound to a disk path.
- **FR-003**: Closing a document MUST remove its opened-document watch interest.
- **FR-004**: Any successful operation that changes an open document's bound path, including Save As and the existing internal Explorer Rename flow, MUST migrate opened-document watch interest from the old path to the new path without changing `documentId`.
- **FR-005**: Open documents that share the same parent directory SHOULD share the underlying directory watch where the platform/backend permits it.
- **FR-006**: 005 MUST NOT require optimization for an extreme number of opened documents spread across unrelated parent directories.

#### Validation and External State

- **FR-007**: Filesystem notifications MUST be treated as change hints that trigger validation, not as authoritative document-state transitions by themselves.
- **FR-008**: Sorakada MUST maintain an external disk state for a bound document sufficient to distinguish at least normal, externally modified, and missing conditions without replacing the existing dirty flag.
- **FR-009**: Dirty state and external disk state MUST remain independent; a document may be dirty and externally modified, dirty and missing, clean and missing, or normal.
- **FR-010**: Sorakada MUST use the existing path identity/canonical comparison rules when associating watch interests and events with open documents; raw path-string equality MUST NOT become a second identity system.
- **FR-011**: Relevant filesystem hints SHOULD be debounced/coalesced so bursts do not cause repeated destructive reloads or repeated prompts, while the final state still converges to current disk reality.
- **FR-012**: Sorakada MUST revalidate an activated disk-bound document and MUST perform a fallback validation when the application window regains focus.
- **FR-013**: Sorakada MUST perform mandatory disk validation immediately before ordinary Save commits to an existing bound path.
- **FR-014**: A validation result that confirms the path does not exist MUST transition the document to missing without closing the document.
- **FR-015**: A transient read/inspection failure for a path that cannot be confirmed missing MUST preserve the current document contents and MUST NOT be converted into missing solely because reading failed.

#### Clean External Modification

- **FR-016**: When validation confirms that a clean document's supported disk contents or supported disk format changed externally, Sorakada MUST automatically reload the disk version into the same `DocumentSession`.
- **FR-017**: Successful clean auto-reload MUST update the document's saved baseline, format metadata, and current disk revision and MUST leave dirty false and external state normal.
- **FR-018**: Successful clean auto-reload MUST clear the document's previous undo/redo history.
- **FR-019**: Successful clean auto-reload MUST preserve every selection anchor/head at the same absolute text offset, clamped to the new document length, and MUST restore a view that keeps the clamped primary selection head visible. Exact pixel scroll preservation is not required when the new content changes line layout.
- **FR-020**: A failed or unsupported external reload MUST NOT replace the current editor content with a partial, undecodable, or invalid result.

#### Dirty External Modification and Save Protection

- **FR-021**: When validation confirms that disk diverged while the document is dirty, Sorakada MUST preserve the in-memory editor content and mark the document externally modified.
- **FR-022**: A dirty externally modified document MUST NOT be auto-reloaded.
- **FR-023**: Ordinary Save of a dirty externally modified document MUST be blocked until the user explicitly chooses to overwrite or cancel.
- **FR-024**: Choosing Cancel at the overwrite decision MUST leave both the Sorakada buffer and disk unchanged by that save attempt.
- **FR-025**: Choosing Overwrite MUST write the current in-memory document using the existing save semantics and MUST only clear dirty/external-modified state and advance baseline/revision after successful completion.
- **FR-026**: If mandatory pre-save validation discovers an external divergence that realtime watching did not previously surface, Save MUST follow the same explicit overwrite protection as any other externally modified dirty document.
- **FR-027**: Any action that intentionally reloads disk content over a dirty document MUST explicitly confirm loss of unsaved Sorakada changes before replacing the buffer.

#### External Delete and Reappearance

- **FR-028**: External deletion of an open file MUST NOT automatically close its tab or destroy its `DocumentSession`.
- **FR-029**: External deletion MUST preserve the complete in-memory content and the document's existing dirty state while setting external state to missing.
- **FR-030**: Save MUST remain available for both clean and dirty missing documents. Saving a missing document MUST attempt to recreate the file at its existing bound path from current in-memory content when the parent directory still exists; the missing branch MUST run before the ordinary clean-document no-op return.
- **FR-031**: Saving a missing document MUST NOT silently create missing ancestor directories; if the original parent path is unavailable, Save fails and the document remains available for Save As.
- **FR-032**: After successful recreation of a missing file, Sorakada MUST refresh the saved baseline/revision, clear missing/external-modified state, and leave the document clean.
- **FR-033**: If a clean missing document's path reappears, Sorakada MUST reload the current supported disk file and return to normal state.
- **FR-034**: If a dirty missing document's path reappears, Sorakada MUST preserve the in-memory buffer and treat the reappeared disk file as external divergence rather than auto-reloading.

#### Internal Filesystem Operations and Robustness

- **FR-035**: Sorakada MUST provide a reusable mechanism that distinguishes/reconciles notifications produced by its own filesystem mutations from genuine external divergence; Save, Save As, and existing Rename/Delete operations that affect watched open documents MUST participate in that mechanism in 005. 005 MUST NOT implement this as “ignore the next N events.”
- **FR-036**: Internal-operation reconciliation MUST compare/validate the post-operation disk state before declaring the operation settled; unrelated external changes occurring during the same interval MUST not be blindly swallowed.
- **FR-037**: The watcher foundation MUST be reusable for later directory/Workspace watching and MUST NOT be hard-coded to direct mutation of opened-document state from an OS callback.
- **FR-038**: The normalized watcher layer MUST be capable of representing watch invalidation/event-loss/overflow conditions even if 005 rarely encounters them, so 006 can request reconciliation rather than assuming an event stream is lossless.
- **FR-039**: Stale asynchronous watcher, validation, or reload completions MUST verify the target document/path binding is still current before mutating session state.
- **FR-040**: Watcher/validation behavior MUST NOT introduce real-time Workspace Explorer synchronization in 005.

#### User Feedback

- **FR-041**: External modified and missing states MUST be visible to the user without repeatedly opening modal dialogs merely because watcher events arrive.
- **FR-042**: The explicit overwrite decision MUST clearly distinguish Overwrite from Cancel and MUST NOT present ordinary Save as though no conflict exists.
- **FR-043**: External reload/read/inspection failures MUST be surfaced non-destructively while keeping the current editor contents available.
- **FR-044**: Registering or migrating opened-document watch interest MUST include a post-subscription validation (or an equivalent race-free ordering) so a disk change occurring between the prior read/adoption and active subscription cannot remain silently undetected.
- **FR-045**: Before recreating a `missing` target, Sorakada MUST revalidate that the target is still absent; if it has reappeared, the operation MUST transition to the normal reappearance/conflict rules rather than silently overwriting the new disk file as a missing-file recreation.

### Key Entities

- **DocumentSession**: Existing open-document identity and editing state. 005 extends its external-disk relationship; it is not replaced by a watcher-specific session model.
- **External Disk State**: Orthogonal state representing whether the bound path is normal, externally modified, or missing. It does not replace `dirty`.
- **Disk Revision**: Existing persisted-file revision metadata used for fast validation and post-operation reconciliation. It is a validation aid rather than the sole truth source.
- **Watch Interest**: The fact that an opened bound document cares about changes to a path. Multiple interests may share one underlying parent-directory watch.
- **Validation Result**: Current interpreted relationship between a document's known persisted baseline and the actual bound path, including unchanged, changed, missing, or temporarily unverifiable.
- **Internal Filesystem Operation Guard**: Reusable coordination state for Sorakada-originated filesystem mutations so watcher events are reconciled rather than misclassified or blindly ignored.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In automated/manual validation, a clean open text file modified externally is reflected in the same Sorakada tab without user confirmation and remains clean in every tested case.
- **SC-002**: In all covered dirty-document external-modification tests, ordinary Save never overwrites the externally changed disk version without an explicit user Overwrite choice.
- **SC-003**: In all covered external-delete tests, the open tab and complete in-memory content survive deletion, and Save successfully recreates the original file when its parent directory still exists.
- **SC-004**: Duplicate/bursty watcher events for the same opened path do not produce duplicate destructive reloads, repeated modal prompts, or inconsistent final document state.
- **SC-005**: A missed realtime event is discovered by at least one defined fallback path (tab activation, window focus, or mandatory pre-save validation) in the corresponding validation tests.
- **SC-006**: Sorakada's own successful Save/Save As does not leave the affected document falsely marked externally modified or missing in regression tests.
- **SC-007**: A stale validation/reload completion cannot mutate a closed document or a document that has since been rebound to another path in race-condition tests.
- **SC-008**: With 50 unchanged disk-bound documents open, a 60-second idle interval performs zero periodic full-content reads. One window-focus validation performs at most one cheap inspection per bound document, performs zero full-content reads for unchanged revisions, and does not synchronously block the focus handler on file-content reads.
- **SC-009**: 005 regression tests confirm Workspace Explorer external-change behavior remains unchanged: external tree updates are not introduced until 006.

## Assumptions

- Sorakada remains Windows-first for 005 while keeping watcher abstractions suitable for later backend/platform extension.
- Existing file reading/writing, encoding/BOM/EOL handling, canonical path identity, `diskRevision`, and `DocumentManager` ownership are reused rather than reimplemented.
- The underlying watcher is event-driven. 005 does not use periodic polling of every open file as its primary mechanism.
- Opened-document watching may share non-recursive parent-directory watches. If open files are spread across many unrelated directories, multiple underlying watches are acceptable.
- Metadata/revision checks are a practical fast-path. 005 does not add persistent content hashing solely to detect pathological external edits that preserve all observed metadata.
- External rename/move recognition, recursive Workspace watching, Explorer synchronization/reconciliation, and directory prefix rewrite are explicitly deferred to 006.
- Diff editor, automatic merge, Git integration, autosave, recovery, local history, search index, and persistent file-identity databases are outside 005.
