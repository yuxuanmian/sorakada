# Feature Specification: Workspace Filesystem Synchronization

**Feature Branch**: `006-workspace-filesystem-sync`

**Created**: 2026-09-19

**Status**: Implemented on `feature-core` and verified — behavior frozen. All 144 tasks in `tasks.md` are complete; the four repository quality gates are green and the manual acceptance matrix was executed by the reporter. See `tasks.md` → "Execution Evidence".

**Input**: Automatically keep the single-root Workspace Explorer synchronized with filesystem structure changes made outside Sorakada, while reusing the watcher foundation from 005, preserving the lazy Explorer model from 003, and never turning Workspace synchronization into a recursive crawler.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See External Creates and Deletes Automatically (Priority: P1)

A user keeps a Workspace open while another tool creates or removes files and directories. Explorer converges automatically without requiring the user to press Refresh, but Sorakada still reads only directory levels it already needs to represent.

**Why this priority**: Automatic structural synchronization is the primary user-visible value of 006 and closes the explicit watcher gap left by 003.

**Independent Test**: Open a Workspace, expand `src`, create and delete entries from another process under the root and `src`, and verify the corresponding loaded Explorer nodes converge automatically while an unopened deep directory is never enumerated merely because events occurred below it.

**Acceptance Scenarios**:

1. **Given** the Workspace root is loaded, **When** an external process creates a direct child under the root, **Then** Explorer automatically shows the new child after bounded reconciliation without a manual Refresh.
2. **Given** an expanded/loaded directory, **When** an external process creates or deletes a direct child in that directory, **Then** Sorakada reconciles that directory's direct children and updates Explorer.
3. **Given** a directory that has never been loaded, **When** external activity occurs anywhere below it, **Then** 006 MUST NOT load that directory solely because of watcher events.
4. **Given** an external process deletes an entire loaded directory subtree, **When** its parent is reconciled, **Then** the subtree disappears as one structural result and pending work belonging to that subtree becomes stale rather than processing every descendant delete event.
5. **Given** an externally deleted file is open as a document, **When** Explorer removes its node, **Then** 006 does not close the Tab; the 005 opened-document external-delete rules remain responsible for the document's `missing` state and recovery.
6. **Given** a Sorakada-originated Create/Rename/Delete already updated Explorer, **When** the OS watcher later reports the same disk effects, **Then** reconciliation is idempotent and MUST NOT create duplicate nodes or undo the successful internal operation.

---

### User Story 2 - Follow Confirmed External Rename and Move (Priority: P1)

A user can rename or move Workspace entries in another program and, when Sorakada can prove that the source and destination are the same filesystem object, Explorer and affected open documents preserve their logical continuity instead of being torn down and recreated.

**Why this priority**: Rename/move is common during Git operations, refactors and file-manager use, and preserving editor state is important for a programmer-focused editor.

**Independent Test**: Open a dirty Workspace file, expand its containing directory, rename/move the file externally, and verify the same document id, buffer, history and dirty state follow the confirmed relocation. Repeat for a directory containing multiple open documents.

**Acceptance Scenarios**:

1. **Given** a loaded file node, **When** the file is externally renamed and Sorakada confirms source/destination filesystem-object continuity, **Then** the existing node follows the new name/path instead of being treated as unrelated remove/create state.
2. **Given** an open clean or dirty document whose file is externally renamed or moved and continuity is confirmed, **When** relocation is adopted, **Then** the same `documentId`, `EditorState`, history, selection and dirty state are preserved while path/display identity changes.
3. **Given** a loaded directory is externally renamed or moved within the Workspace and directory identity continuity is confirmed, **When** reconciliation completes, **Then** its surviving cached subtree and expanded state follow the directory, and all open documents under that directory update their path prefix through the document lifecycle owner.
4. **Given** a selected node is confirmed as externally renamed/moved, **When** the new location remains represented by the current Explorer, **Then** selection follows that same logical node.
5. **Given** a Windows case-only rename such as `foo.ts` to `Foo.ts`, **When** filesystem-object continuity is confirmed, **Then** Explorer and open-document path casing update even though the canonical comparison key is case-insensitive.
6. **Given** an external rename/move event cannot be proven to represent the same filesystem object, **When** Explorer reconciles, **Then** Sorakada treats the result as ordinary removal plus creation and MUST NOT guess continuity from name, size, timestamps, content similarity or event ordering.
7. **Given** an external relocation target is already owned or incompatibly reserved by another live document/path operation, **When** the disk relocation is observed, **Then** Explorer follows disk truth but DocumentManager MUST NOT merge sessions or force the affected document to adopt the conflicting destination.
8. **Given** a confirmed relocation rebinds an open document to a new path, **When** 005 resumes opened-document watching at the new path, **Then** the new disk target is validated before external state is considered resolved; relocation MUST NOT silently clear a real content conflict that occurred during the move.

---

### User Story 3 - Converge Despite Noisy, Lost or Reordered Events (Priority: P1)

A user can run build tools, Git operations and other programs that produce duplicate, reordered, coalesced or missing filesystem notifications. Explorer uses notifications only to decide what to validate and converges from current filesystem state rather than replaying an event log.

**Why this priority**: OS watcher streams are not durable truth. Correctness under event loss and reordering is necessary for automatic synchronization to be trustworthy.

**Independent Test**: Inject duplicate/reordered hints, rename pairs, unknown hints and watcher invalidation/overflow for a loaded tree; verify Sorakada performs bounded directory reconciliation and ends in the same state as a direct read of the current filesystem.

**Acceptance Scenarios**:

1. **Given** several watcher hints affect the same loaded parent directory within one burst, **When** they are processed, **Then** they coalesce into bounded reconciliation work rather than one filesystem read per event.
2. **Given** Create/Delete/Rename hints arrive in an order different from the actual operation order, **When** reconciliation runs, **Then** the resulting Explorer state reflects the current disk listing rather than the hint sequence.
3. **Given** a Create is followed quickly by Delete before reconciliation, **When** the final filesystem contains neither entry, **Then** Explorer may show no intermediate node at all.
4. **Given** a Delete is followed quickly by recreation at the same path, **When** the final path exists, **Then** Explorer reflects the current entry while filesystem-object identity determines whether any prior logical-node continuity is valid.
5. **Given** the watcher reports overflow, rescan-required, invalidation or loss of completeness, **When** 006 handles it, **Then** fine-grained assumptions are discarded and a bounded recovery reconciliation is scheduled for the Workspace root and relevant loaded/expanded areas.
6. **Given** a watcher event is missed entirely, **When** periodic expanded-area reconciliation or a later explicit Refresh runs, **Then** the Explorer still converges to current disk state.
7. **Given** a directory reconciliation is already in flight and another relevant hint arrives, **When** the first read completes, **Then** Sorakada does not launch unbounded parallel reads; it performs at most the additional reconciliation needed to cover the newer dirty state.
8. **Given** watcher, periodic reconciliation and manual Refresh all request the same directory, **When** work is scheduled, **Then** they share one reconciliation path with stale-result protection instead of independently mutating Explorer.

---

### User Story 4 - Stay Responsive in Large Developer Workspaces (Priority: P1)

A user can keep a realistic frontend/monorepo Workspace open while package managers, builds or Git operations touch many files. Synchronization remains bounded by visible/loaded Explorer state rather than total descendant count.

**Why this priority**: The feature is specifically expected to survive `node_modules` and event storms. A correct watcher that freezes the editor is not acceptable.

**Independent Test**: Open a project containing a very large `node_modules`, leave it collapsed, run a filesystem-heavy operation, and verify Sorakada remains interactive and never recursively enumerates the unopened subtree. Then expand only a small branch and verify only that represented branch participates in ongoing reconciliation.

**Acceptance Scenarios**:

1. **Given** a Workspace containing hundreds of thousands of descendant entries under collapsed directories, **When** the watcher starts, **Then** Sorakada MUST NOT pre-scan descendants in order to establish synchronization.
2. **Given** `node_modules` is collapsed and never loaded, **When** `npm install` or equivalent causes a large event storm below it, **Then** 006 MUST NOT recursively read `node_modules` or enqueue work proportional to its descendant count.
3. **Given** a directory was loaded previously but is currently collapsed, **When** no watcher hint specifically requires reconciliation there, **Then** it is excluded from periodic reconciliation.
4. **Given** a loaded cached directory is re-expanded, **When** its cached children are rendered, **Then** Sorakada schedules an immediate direct-child reconciliation so stale cached structure converges without waiting for the next periodic pass.
5. **Given** event volume exceeds the normal fine-grained queue budget, **When** 006 enters storm recovery, **Then** duplicate/detail work is collapsed, user-triggered expansion remains higher priority than background recovery, and eventual convergence is preserved.
6. **Given** periodic reconciliation takes longer than its scheduling interval, **When** the next interval arrives, **Then** another periodic run MUST NOT stack on top of the still-running pass.
7. **Given** a watcher overflow occurs after the user has previously loaded many directories, **When** recovery begins, **Then** Sorakada prioritizes the root and currently expanded directories instead of immediately rereading every cached directory at once.

---

### User Story 5 - Survive Workspace and Watcher Lifecycle Changes (Priority: P2)

A user can replace/close a Workspace, temporarily lose access to its root, or encounter a watcher failure without stale callbacks corrupting the new Explorer or automatically closing documents.

**Why this priority**: Workspace lifecycle is asynchronous and 006 adds long-lived background work. Stale results must not cross WorkContext boundaries.

**Independent Test**: Start reconciliation in Workspace A, switch to Workspace B before it finishes, then force old watcher/read completions and verify none appear in B. Separately simulate watcher startup failure and root loss/reappearance.

**Acceptance Scenarios**:

1. **Given** Workspace A has live watcher/reconciliation work, **When** Workspace B replaces it, **Then** A's watcher subscription is retired and every late A event/read completion is ignored.
2. **Given** the user closes the Workspace while reconciliation is pending, **When** background work later completes, **Then** closing does not wait for the queue and no completion recreates Explorer state.
3. **Given** Workspace watcher startup fails, **When** the Workspace root itself remains readable, **Then** opening the Workspace still succeeds in a degraded synchronization mode supported by periodic reconciliation and manual Refresh.
4. **Given** a live watcher becomes invalid/degraded, **When** the failure is detected, **Then** Sorakada keeps the WorkContext open, does not spam modal notifications, and can attempt watcher reconstruction after later successful filesystem access.
5. **Given** the Workspace root itself becomes unreadable or disappears, **When** reconciliation confirms the failure, **Then** the WorkContext remains active and Explorer uses the existing unavailable/error state rather than following or closing the Workspace automatically.
6. **Given** the Workspace root is externally renamed or moved to another path, **When** the original root path is no longer readable, **Then** 006 does not automatically follow the moved root; the current WorkContext remains bound to the original root and becomes unavailable.
7. **Given** the original Workspace root path later reappears and becomes readable, **When** periodic/watcher recovery or Refresh verifies it, **Then** the existing WorkContext may automatically recover its Explorer at that original path without being treated as a move-follow operation.
8. **Given** a watcher is rebuilt, **When** callbacks from the previous watcher generation arrive late, **Then** they cannot schedule work for the current generation.

---

### User Story 6 - Preserve Explorer Interaction State While Synchronizing (Priority: P2)

A user's selection, expansion and inline editing remain predictable while background reconciliation updates structural data.

**Why this priority**: Automatic updates should feel like normal editor behavior, not like repeated manual refreshes that reset the Tree or interrupt unrelated work.

**Independent Test**: Select/expand nodes, begin an inline rename in one directory, then trigger unrelated and directly conflicting external changes and verify only the affected interaction state changes.

**Acceptance Scenarios**:

1. **Given** a selected node is unaffected by reconciliation elsewhere, **When** Explorer updates, **Then** selection remains unchanged.
2. **Given** a selected node is externally deleted, **When** deletion is reconciled, **Then** the invalid selection is cleared.
3. **Given** an expanded directory receives child Create/Delete changes, **When** reconciliation applies them, **Then** that directory remains expanded.
4. **Given** an inline create/rename editor is active and an unrelated entry changes in the same or another directory, **When** reconciliation runs, **Then** the inline edit is not cancelled merely because background synchronization occurred.
5. **Given** the object being inline-renamed is externally removed/renamed or its containing Tree context ceases to exist, **When** reconciliation confirms the conflict, **Then** the temporary inline edit is cancelled before the authoritative Tree state is applied.
6. **Given** a symlink/junction exposes a directory through more than one logical Tree position, **When** synchronization occurs, **Then** Sorakada may represent the same filesystem object in each valid logical position and MUST NOT globally deduplicate Tree nodes by filesystem-object identity.
7. **Given** following a symlink/junction would repeat a canonical ancestor, **When** that node is expanded or reconciled, **Then** the existing ancestor-cycle protection remains in force and background synchronization MUST NOT create recursive traversal through the cycle.

### Edge Cases

- The current backend may emit a paired rename source with a target and a separate target Create. The pair is still a hint: continuity requires filesystem-object evidence, not merely the event shape.
- A file can be modified during an external rename/move. If the file is open, path relocation must be followed by 005 validation at the new binding so a dirty external-content conflict is not silently cleared.
- A file can be moved out of the Workspace. Explorer removes it from the root. If 006 can reliably confirm the new path and object continuity, an open document may rebind and naturally become `outside`; otherwise 005 may observe the old path as `missing`.
- A file can be moved into the Workspace from outside. It is structurally a Create. If an already-open outside document can be proven to be that same filesystem object, its path may rebind and its derived Workspace relation becomes `inside`.
- Moving an entry out and quickly back in does not create a special grace period. Sorakada reconciles what can be proven from current filesystem state.
- Filesystem-object identity may be unavailable on some platform/filesystem. In that case Sorakada remains correct by falling back to remove/create semantics; continuity is optional, guessing is forbidden.
- Native filesystem-object identity is not the canonical path ownership key. Hard-link/path ownership behavior established by 002/003 must not be silently changed merely because two paths can refer to one native object id. If several represented entries share one object id (for example hard links), identity matching is ambiguous unless the source/target candidate is independently narrowed; ambiguous identity alone MUST NOT collapse or relocate those logical paths.
- A root recursive watcher may coexist with 005 non-recursive opened-document interest in the same physical directory. The watcher manager must preserve both consumers' required coverage; one scope must not accidentally downgrade the other.
- The Workspace may have been opened through a non-canonical/equivalent root spelling or a symlink/junction. Recursive watcher events may therefore use canonical/native path spelling that differs from Explorer's logical `WorkContext.rootPath`; 006 must map events through subscription-relative path information rather than matching raw watcher paths directly against Tree-node paths.
- Watching a root may not reliably report mutation of the root directory entry itself on every platform. Root availability must therefore converge through direct root reads/periodic recovery and not depend solely on a root-self watcher event.
- An expanded symlink/junction target outside the Workspace may not be covered by the Workspace-root recursive watcher. Periodic expanded-directory reconciliation and manual Refresh remain the convergence paths for such represented nodes.
- A directory can be renamed repeatedly (`a -> b -> c`) before reconciliation. Sorakada only needs to converge to the current location and preserve continuity if the same object can still be proven; intermediate names are not application history.
- A parent directory may disappear while descendant lazy-load/reconciliation reads are in flight. Once the parent removal is authoritative, descendant completions must be invalidated and dropped.
- A user may expand a directory during event-storm recovery. User-requested browsing must not wait behind an unbounded background queue.
- External filesystem changes can occur while Sorakada Rename/Delete is waiting on confirmation or performing its disk mutation. Destructive/path-changing internal operations must revalidate the target identity before acting so a path replacement cannot make Sorakada rename/delete a different object than the one the user selected.
- A Manual Refresh while watcher reconciliation is in flight is an explicit newer intent. Older background results may finish I/O but must not overwrite results belonging to the Refresh generation.
- Periodic reconciliation while the window is unfocused/minimized need not preserve foreground cadence. An implementation may reduce background cadence, but focus regain should request a prompt bounded reconciliation of the currently relevant expanded area.

## Requirements *(mandatory)*

### Functional Requirements

#### Workspace Watch Scope and Lifecycle

- **FR-001**: 006 MUST reuse the generic filesystem watcher foundation introduced by 005 rather than adding a second OS watcher framework.
- **FR-002**: Each active single-root WorkContext MUST have one logical recursive Workspace-root watch interest while realtime watching is available.
- **FR-003**: 006 MUST NOT allocate one persistent OS watcher per Explorer directory merely because that directory is loaded or expanded.
- **FR-004**: Establishing a Workspace watch MUST NOT require recursively enumerating the Workspace.
- **FR-005**: Workspace watching MUST begin only for the current committed WorkContext and MUST stop/retire when that WorkContext is closed or replaced.
- **FR-006**: Every Workspace watch lifecycle MUST carry a WorkContext/watch generation (or equivalent token) so stale callbacks cannot target a newer Workspace lifecycle.
- **FR-007**: Watcher startup failure MUST NOT make an otherwise readable Workspace fail to open.
- **FR-008**: A watcher failure/invalidation MUST be represented separately from Workspace-root unreadability; a degraded watcher alone MUST NOT close or mark the root unavailable.
- **FR-009**: The watcher manager MUST support simultaneous 005 non-recursive document interests and 006 recursive Workspace interests for the same underlying directory without reducing either consumer's required coverage.
- **FR-010**: Watcher invalidation/overflow/loss-of-completeness signaling MUST reach every affected consumer scope; global invalidation MUST NOT be hard-coded as a 005/non-recursive-only condition.
- **FR-011**: Rebuilding a Workspace watcher MUST invalidate the prior watch generation before the replacement can publish authoritative hints.
- **FR-012**: Root entry rename/move detection MUST NOT be the sole mechanism by which root availability is determined.

#### Reconciliation as Filesystem Truth

- **FR-013**: Filesystem watcher events MUST be treated as hints that request reconciliation, not as authoritative Explorer mutations.
- **FR-014**: The authoritative structural truth for a represented directory MUST be a fresh one-level filesystem read of that directory's direct children.
- **FR-015**: 006 MUST NOT replay watcher event history as though event order were guaranteed to match filesystem operation order.
- **FR-016**: Multiple hints that affect the same represented directory in a short burst SHOULD be coalesced before filesystem reads.
- **FR-017**: All watcher-triggered, periodic, re-expansion and manual reconciliation MUST converge through one canonical Explorer directory-reconciliation path rather than independent mutation pipelines.
- **FR-018**: At most one authoritative directory read for the same current Explorer node/generation SHOULD be in flight for equivalent background reconciliation work.
- **FR-019**: If a relevant new hint arrives while a directory reconciliation is in flight, Sorakada MUST remember that the directory became dirty again and perform whatever additional current read is needed after the in-flight read instead of creating an unbounded parallel queue.
- **FR-020**: Every completed reconciliation read MUST prove that its WorkContext, target node/object and request generation are still current before mutating Explorer.
- **FR-021**: A newer Manual Refresh or newer read intent for a directory MUST supersede older background results for that directory.
- **FR-022**: Reconciliation of one directory MUST read only that directory's direct children and MUST NOT recursively enumerate descendants as part of the read.
- **FR-023**: A watcher hint for a never-loaded directory MUST NOT cause that directory to be loaded solely for background synchronization.
- **FR-024**: Removing a represented parent subtree MUST invalidate pending lazy-load/reconciliation work for descendants so stale completions cannot repopulate the removed subtree.
- **FR-025**: Filesystem read failure for one non-root directory MUST remain localized to that represented node and MUST NOT invalidate the entire WorkContext.
- **FR-026**: Sorakada-originated successful Create/Rename/Delete updates and later watcher-driven reconciliation MUST be idempotent with each other.
- **FR-027**: Correctness MUST NOT depend on suppressing “the next N” watcher events, a timing blacklist, or any exact count of events generated by Sorakada's own filesystem operations.

#### External Create and Delete

- **FR-028**: An external Create whose parent directory is represented/loaded MUST become visible after that parent is reconciled.
- **FR-029**: An external Create under an unrepresented/unloaded directory MUST remain undiscovered until a normal later read makes that directory relevant.
- **FR-030**: An external Delete whose parent is represented/loaded MUST remove the absent child after parent reconciliation.
- **FR-031**: External deletion of a represented directory MUST remove its represented subtree without requiring one delete transition per descendant.
- **FR-032**: 006 MUST NOT close an open DocumentSession merely because its Explorer node disappeared externally.
- **FR-033**: Open-document external deletion/content behavior MUST continue through 005's `externalState` and validation rules.
- **FR-034**: A rapid Delete->Recreate at the same path MUST be interpreted from the current listing and filesystem-object identity rather than assuming path equality proves object continuity.
- **FR-035**: External structural changes MUST NOT automatically change the active editor Tab.
- **FR-036**: External structural changes MUST NOT automatically expand unopened directories solely to reveal the change.

#### Filesystem-Object Identity and Rename/Move Continuity

- **FR-037**: 006 MUST introduce or reuse filesystem-object identity evidence that can remain stable across a rename/move of the same object on supported filesystems.
- **FR-038**: Filesystem-object identity used for relocation continuity MUST remain conceptually separate from canonical path `comparisonKey`, which continues to own path/session destination semantics.
- **FR-039**: Explorer MUST preserve rename/move continuity only when source and destination can be proven to represent the same filesystem object.
- **FR-040**: A paired rename watcher hint MAY narrow the candidate source/destination set but MUST NOT by itself be the proof required by FR-039.
- **FR-041**: Sorakada MUST NOT infer rename/move continuity from content, filename similarity, size, timestamps, directory shape or event adjacency when filesystem-object proof is absent.
- **FR-042**: If filesystem-object identity is unavailable or continuity cannot be confirmed, structural reconciliation MUST fall back to remove/create behavior.
- **FR-043**: A confirmed file rename/move within the represented Workspace SHOULD preserve the existing Explorer logical node identity/state rather than replacing it unnecessarily.
- **FR-044**: A confirmed directory rename/move SHOULD preserve surviving cached descendants, expansion state and selection by rebasing the represented subtree instead of recursively rereading the whole subtree.
- **FR-045**: Confirmed identity of the directory being relocated is sufficient to rebase paths of currently open documents underneath that directory; 006 MUST NOT recursively scan the directory contents to prove each open descendant separately.
- **FR-046**: Case-only rename on a case-insensitive platform MUST update user-visible spelling/path casing when object continuity is confirmed.
- **FR-047**: Two valid logical Explorer positions that reach the same filesystem object through symlink/junction paths MUST remain separate Tree nodes; filesystem-object identity MUST NOT become a global Tree deduplication key.
- **FR-048**: A move within the Workspace MUST reconcile both the source and target represented parent directories when both are relevant.
- **FR-049**: A move out of the Workspace MUST remove the entry from Explorer; 006 MUST NOT start arbitrary Workspace-external directory watches solely to keep tracking it.
- **FR-050**: If a move out of the Workspace yields reliable target-path and object-continuity evidence, an already-open document MAY rebind to that outside path through DocumentManager; otherwise the original 005 missing/conflict behavior remains authoritative.
- **FR-051**: A move into the Workspace MUST appear structurally as an addition; an already-open outside document MAY rebind and derive `inside` relation only when object continuity with the new target is proven.
- **FR-052**: 006 MUST NOT introduce a time-based grace period merely to guess whether a moved-out entry will move back.
- **FR-053**: Repeated external renames/moves need only converge to the current provable filesystem location; 006 MUST NOT persist intermediate rename history.
- **FR-054**: External Workspace-root rename/move MUST NOT automatically replace the WorkContext root path.
- **FR-055**: If the original root path becomes unreadable because the root was moved, the existing WorkContext MUST remain bound to that original path and enter the existing unavailable state.

#### DocumentManager Coordination and Data Safety

- **FR-056**: Any confirmed external relocation of an open file MUST be committed through DocumentManager (or its canonical document lifecycle boundary), never by mutating DocumentSession fields directly from watcher/Explorer code.
- **FR-057**: External file relocation adoption MUST preserve stable `documentId`, live editor text, `EditorState`, history, selection and dirty state.
- **FR-058**: External directory relocation MUST update path prefixes of affected open documents through one manager-owned relocation operation compatible with the existing internal Rename behavior.
- **FR-059**: Dirty documents MUST be eligible to follow a confirmed external rename/move; dirty state alone MUST NOT block path continuity.
- **FR-060**: A confirmed external relocation MUST migrate 005 opened-document watch interest to the adopted destination through the existing bound-path interest mechanism.
- **FR-061**: After external relocation, the new document binding MUST be validated under 005 before a prior `missing`/`modified` state is considered resolved; 006 MUST NOT clear a real content conflict merely because path continuity was proven.
- **FR-062**: External relocation adoption MUST preserve the invariant that one canonical destination is owned by at most one live DocumentSession.
- **FR-063**: If the external relocation destination is already owned or incompatibly reserved by another live document/path operation, DocumentManager MUST reject adoption for the relocating session without merging or overwriting either session.
- **FR-064**: When relocation adoption is rejected by FR-063, Explorer still reflects actual disk structure and the affected document remains subject to 005 validation of its existing binding.
- **FR-065**: External relocation MUST coordinate with in-flight Open, Save, Save As, internal Rename and Delete operations so stale async completion cannot restore an old path or steal a newer destination.
- **FR-066**: Internal Rename/Delete must verify immediately before the destructive/path-changing filesystem call that the selected source still represents the expected filesystem object; if it was externally replaced, the operation MUST fail/reconcile rather than acting on the replacement.
- **FR-067**: The new filesystem-object identity mechanism MUST NOT silently redefine 002/003 hard-link or canonical-path ownership semantics.

#### Event Storms, Periodic Reconciliation and Manual Refresh

- **FR-068**: Watcher processing MUST deduplicate affected-directory work so event volume does not translate one-for-one into directory reads.
- **FR-069**: 006 MUST define a bounded event-storm/overflow mode that can discard fine-grained pending detail and recover from current filesystem state.
- **FR-070**: Storm/overflow recovery MUST prioritize the Workspace root and currently expanded represented directories before lower-priority cached state.
- **FR-071**: User-requested directory expansion/read MUST have priority over background storm-recovery work waiting in the queue.
- **FR-072**: Even during overflow recovery, Sorakada MUST NOT recursively scan the full Workspace.
- **FR-073**: 006 MUST provide low-frequency periodic reconciliation as a correctness fallback for the Workspace root and currently expanded represented directories.
- **FR-074**: Periodic reconciliation MUST NOT routinely reread loaded-but-collapsed directories.
- **FR-075**: A loaded-but-collapsed directory that receives a relevant watcher hint MAY be reconciled despite not participating in periodic passes.
- **FR-076**: Re-expanding a loaded cached directory MUST make cached children available immediately and MUST request a direct-child reconciliation without waiting for the next periodic cycle.
- **FR-077**: Periodic reconciliation cycles MUST NOT overlap themselves; a later tick cannot stack a second full periodic pass while the previous pass remains active.
- **FR-078**: The exact periodic interval and event-coalescing thresholds are implementation parameters, not user-visible contracts, but they MUST satisfy the responsiveness/success criteria below.
- **FR-079**: When the application is backgrounded/minimized, periodic cadence MAY be reduced; focus regain SHOULD request bounded reconciliation of currently relevant expanded Workspace state.
- **FR-080**: Manual Explorer Refresh MUST remain available and MUST retain 003 semantics of rereading all already-loaded directories, including loaded-but-collapsed directories, while leaving never-loaded descendants unloaded.
- **FR-081**: Manual Refresh MUST cancel/supersede stale background directory results that could otherwise overwrite its newer filesystem view.
- **FR-082**: Manual Refresh MUST continue cancelling an uncommitted inline create/rename editor before applying refreshed state, as defined by 003.
- **FR-083**: Periodic/watcher reconciliation MUST NOT cancel an unrelated inline edit merely because background filesystem state changed elsewhere.

#### Explorer Interaction, Symlinks and State Preservation

- **FR-084**: Reconciliation MUST preserve expanded state for surviving directory nodes unless the directory itself is removed or continuity cannot be preserved.
- **FR-085**: Reconciliation MUST preserve selection when the selected logical node survives unchanged or via confirmed relocation.
- **FR-086**: Reconciliation MUST clear selection when the selected node is confirmed absent and no continuity was established.
- **FR-087**: If the object currently being inline-renamed disappears/relocates externally, or its containing Tree context becomes invalid, 006 MUST cancel that inline edit before applying authoritative structural state.
- **FR-088**: Unrelated external changes MUST NOT cancel an active inline create/rename editor.
- **FR-089**: Existing symlink/junction ancestor-cycle protection from 003 MUST apply to background reconciliation as well as direct user expansion.
- **FR-090**: 006 MUST NOT maintain a global “visited filesystem object” graph that prevents the same non-cyclic symlink/junction target from appearing in multiple logical Tree locations.
- **FR-091**: Expanded symlink/junction directories whose physical target lies outside the Workspace-root recursive watch MUST still converge through periodic direct-directory reconciliation and Manual Refresh.
- **FR-092**: Tab activation MUST remain independent from Explorer selection/expansion; automatic filesystem synchronization MUST NOT add implicit Tab-to-Tree location behavior.
- **FR-093**: Automatic structural updates SHOULD remain silent during ordinary convergence and MUST NOT produce a toast/modal for every Create/Delete/Rename event.
- **FR-094**: Watcher overflow/degraded state SHOULD be handled internally unless it results in a user-actionable Workspace availability/error condition.

#### Root Availability and Recovery

- **FR-095**: Root read failure MUST continue to use the existing 003 WorkContext/Explorer unavailable state rather than automatically closing the Workspace.
- **FR-096**: A watcher failure with a readable root MUST NOT set root unavailable solely because the realtime channel failed.
- **FR-097**: Successful later direct root access MAY clear root-unavailable and MUST permit the Explorer to recover at the same original root path only when the read still resolves to the stored canonical WorkContext identity; a retargeted root symlink/junction or different canonical root requires an explicit Open Folder decision.
- **FR-098**: Recovery at the original root path MUST NOT be interpreted as permission to follow a root that was moved elsewhere.
- **FR-099**: If watcher service was degraded when direct root access later succeeds, 006 SHOULD attempt to restore the recursive root watch without blocking Explorer usability on that attempt.
- **FR-100**: Root recovery/re-watch work MUST use the current WorkContext generation so a revived old root cannot overwrite a newer Workspace.
- **FR-101**: Closing/replacing a Workspace MUST NOT wait for every pending watcher/reconciliation I/O operation to finish; invalidating their ability to commit is sufficient.
- **FR-102**: Closing/replacing a Workspace MUST dispose periodic timers and stop scheduling new reconciliation for the retired context.
- **FR-103**: A duplicate Open Folder of the same active canonical root remains a no-op for WorkContext identity; 006 MUST NOT tear down/recreate a healthy watcher solely because of the duplicate request.
- **FR-104**: A same-canonical-root Open Folder that proves a previously unavailable root readable MAY participate in root recovery without changing WorkContext identity.

#### Concurrency and Scheduling

- **FR-105**: Watcher hints, periodic passes, user expansion and Manual Refresh MUST share reconciliation ownership so they cannot independently commit contradictory versions of one directory.
- **FR-106**: Reconciliation scheduling MUST be bounded; a sustained event stream MUST NOT create an unbounded promise/task queue proportional to raw event count.
- **FR-107**: Parent removal/replacement MUST invalidate pending descendant work before that work can commit.
- **FR-108**: A directory relocation MUST invalidate old-path lazy-load/reconciliation completions even when the same node is preserved at its new path.
- **FR-109**: A newer rename/move of the same object MUST supersede an older pending relocation decision.
- **FR-110**: External relocation handling and Sorakada path mutations for the same source/destination MUST serialize or retry through existing path-operation coordination rather than racing to mutate DocumentManager ownership.
- **FR-111**: If a background reconcile detects a structural state while an internal Sorakada operation is still settling, correctness MUST come from final filesystem reconciliation and existing operation generations, not from assuming which watcher event was “ours.”
- **FR-112**: A stale completion MUST be harmless even if underlying I/O cannot be physically cancelled.
- **FR-113**: Reconciliation state MUST be independent from React rendering state in a way that prevents a stale filesystem result from overwriting newer user interaction state such as a collapse/expand toggle.
- **FR-114**: User collapse during an in-flight reconciliation MUST remain collapsed when the read completes; the read may update cache but MUST NOT force the node open.
- **FR-115**: User expansion during an in-flight/storm period MUST remain expanded unless the directory is proven absent or cyclic/unreadable under existing rules.
- **FR-116**: Automatic reconciliation MUST not mutate document text; any document-content adoption remains exclusively in 005/DocumentManager validation paths.
- **FR-117**: 006 MUST NOT add Workspace indexing, content hashing, recursive background crawling or a persistent filesystem event log in order to implement synchronization.
- **FR-118**: Recursive Workspace watcher events MUST be mappable from the backend's canonical watched directory to the current logical `WorkContext.rootPath` through subscription-relative path information (or an equivalent platform-correct contract); 006 MUST NOT rely on raw watcher-path string equality to locate Explorer nodes.

### Key Entities *(include if feature involves data)*

- **Workspace Watch Interest**: The recursive logical watch bound to the current WorkContext root and a watch generation. It is a source of hints, not structural truth.
- **Workspace Watch Coordinator**: The 006 consumer of the generic watcher stream. It owns Workspace watcher lifecycle, event coalescing/storm handling, periodic scheduling and requests to the Explorer reconciliation path; it does not own document text or raw filesystem bytes.
- **Directory Reconciliation State**: Per represented directory coordination for current generation, in-flight read, dirty-again state and scheduling priority. It exists to deduplicate and serialize direct-child reads without becoming a persistent index.
- **Filesystem Object Identity**: Opaque/native identity evidence that may remain stable when the same file/directory is renamed or moved. It is used only to prove continuity/replacement and is distinct from canonical path ownership keys.
- **Explorer Node**: Existing 003 logical Tree position. 006 may extend it with filesystem-object identity metadata needed for reconciliation but must keep logical node identity distinct from physical object identity.
- **Directory Snapshot**: The currently represented direct-child set for a loaded directory, including enough identity information to diff additions/removals and prove rename/move continuity when available.
- **WorkContext Generation**: Existing Workspace lifecycle identity plus the watch/reconciliation generation that makes late callbacks/results harmless after replace/close/rebuild.
- **Document Binding**: Existing DocumentManager-owned binding between a stable `documentId` and its current canonical path identity. 006 can request a confirmed relocation; it does not own the binding directly.

## Superseded Requirements

006 intentionally changes the following 003 behavior. The 003 specification remains the historical contract for that milestone; the rules below take precedence from 006 onward.

### SR-001 - External Explorer Changes Require Manual Refresh

**Previous 003 behavior**: External filesystem changes are required to converge only after a relevant read/Manual Refresh (`003 FR-087`), and continuous file watching was explicitly deferred.

**006 behavior**: The active Workspace receives automatic watcher-driven reconciliation plus periodic expanded-area fallback. Manual Refresh remains available as the explicit full reconciliation of already-loaded Explorer state.

### SR-002 - Cached Re-expansion Performs No Read

**Previous 003 behavior**: Collapsing and re-expanding a loaded directory reused cache without another directory read until Refresh or a Sorakada-originated mutation (003 User Story 2 acceptance scenario 3, `FR-028`, `SC-003`).

**006 behavior**: Cached children remain immediately reusable for responsive rendering, but re-expanding a loaded cached directory also schedules an immediate direct-child reconciliation so externally stale cache does not remain visible until a later periodic cycle.

### SR-003 - Refresh Exists Without Continuous Watching

**Previous 003 behavior**: `FR-082` stated that the manual loaded-tree Refresh did not require continuous filesystem watching, because watcher functionality was outside 003.

**006 behavior**: Continuous Workspace watching now exists, but the Manual Refresh operation itself retains the same loaded-tree semantics: all already-loaded directories are reread, loaded-but-collapsed directories are included, never-loaded descendants stay unloaded, and inline edit cancellation remains specific to explicit Refresh.

## Compatibility with 005

006 activates capabilities that 005 deliberately deferred, but does not weaken 005's document-safety rules:

- `OpenedDocumentWatchCoordinator` remains an opened-document consumer. It MUST NOT become the Workspace tree consumer.
- 005's rule that external rename/move MUST NOT be guessed remains valid. 006 only requests document path relocation after filesystem-object continuity is proven.
- 005 `externalState`, mandatory pre-save validation, dirty overwrite protection, missing recovery and content reload semantics remain authoritative after any 006 path relocation.
- A 006 relocation may cause the 005 watcher interest to migrate through the manager's existing binding-change notification, but 006 does not directly manipulate 005 subscriptions.
- The generic Rust/Tauri watcher, normalized event DTO and internal path-operation coordination are reused/extended rather than duplicated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For externally created/deleted direct children of the Workspace root or a currently represented loaded directory, Explorer converges automatically in all deterministic integration tests without requiring Manual Refresh.
- **SC-002**: A Workspace with at least 100,000 descendant entries under unopened/collapsed directories can keep automatic synchronization enabled without any recursive enumeration of those unopened descendants during watcher startup, ordinary event handling or periodic reconciliation.
- **SC-003**: In a fixture where `node_modules` contains at least 50,000 descendants and remains unopened, a synthetic/real event storm of at least 10,000 raw hints does not cause 10,000 directory reads; affected-directory work remains bounded by the represented/expanded set, and deterministic scheduler tests prove a user selection/expansion read can run ahead of the remaining background recovery backlog rather than waiting for that backlog to drain.
- **SC-004**: Duplicate/reordered watcher hints and explicit invalidation/overflow tests converge to the same Explorer structure as a fresh direct-child read of every represented target, with no duplicate Tree nodes.
- **SC-005**: Confirmed external file rename/move preserves the same open `documentId`, dirty state, editor text and undo/redo history in every covered clean/dirty relocation test; unconfirmed relocation never guesses continuity.
- **SC-006**: Confirmed external directory relocation containing multiple open documents rebases all affected document paths without recursively scanning the directory contents and without producing duplicate destination ownership.
- **SC-007**: A Workspace switch/close during watcher, periodic or directory-read work produces zero stale nodes in the replacement/empty Explorer across race-condition tests.
- **SC-008**: A watcher startup/failure scenario with a readable root leaves the Workspace usable through periodic reconciliation and Manual Refresh; root-unavailable is reserved for actual root-read failure.
- **SC-009**: Loaded-but-collapsed directories perform zero periodic reads over a 60-second idle test unless a relevant watcher hint or explicit Manual Refresh targets them; re-expansion requests one bounded direct-child reconciliation.
- **SC-010**: A watcher overflow or synthetic 10,000-event burst cannot create an unbounded reconciliation queue; after input stops, the root and currently expanded represented directories converge without recursively scanning never-loaded descendants.
- **SC-011**: Internal Sorakada New/Rename/Delete plus their echoed watcher events remain idempotent: final Explorer state contains exactly the on-disk entries and no duplicate/missing node attributable solely to self-generated notifications.
- **SC-012**: Every repository quality gate passes after implementation: `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` from `src-tauri`.

## Assumptions

- Sorakada remains Windows-first for 006, while the watcher and filesystem-object identity contracts should degrade safely on platforms/filesystems where equivalent identity information is unavailable.
- The existing `notify`-based watcher foundation from 005 is retained; 006 does not add another watcher dependency unless repository evidence proves the existing backend cannot satisfy the approved requirements.
- The active Workspace remains single-root. Multi-root watcher coordination is not part of 006.
- A recursive root watch is a hint channel. It is not required to cover symlink targets outside the root or every root-self mutation reliably; direct directory reads remain authoritative.
- Filesystem-object identity may be exposed as an opaque serializable token. Its exact platform representation is an implementation detail, but it must not replace canonical path comparison keys for destination ownership.
- Directory listing may carry lightweight object-identity metadata needed for reconciliation; it must not read file contents or recursively inspect descendants.
- Periodic reconciliation is low frequency and bounded to the root/currently expanded represented directories. Exact timers/thresholds are implementation details validated by the success criteria.
- Manual Refresh keeps the broader 003 loaded-tree behavior and therefore may reread previously loaded collapsed directories when the user explicitly requests it.
- Workspace Search/Index, Git integration, session persistence, multi-root, Tree drag/drop Move UI, Copy/Cut/Paste, recursive Expand All and watcher-settings/exclude-pattern UI remain outside this feature.

## Out of Scope / Deferred

- Multi-root Workspace watching
- Workspace content search or filesystem indexing
- Persistent filesystem event history/timeline
- Git/source-control integration or Git-aware file status
- User-configurable watcher exclude patterns or `.gitignore`-driven watch filtering
- Tree drag-and-drop Move UI, Copy/Cut/Paste or batch filesystem mutation UI
- Recursive/unbounded Expand All
- Automatic following of an externally moved/renamed Workspace root
- Persistent per-Workspace Explorer state or watcher state across application launches
- Diff/merge UI for document external-content conflicts
- Automatic content merge during external rename/move
- Replacing 005 document validation with Workspace watcher assumptions
- A global symlink target graph or global Tree deduplication by filesystem-object id
