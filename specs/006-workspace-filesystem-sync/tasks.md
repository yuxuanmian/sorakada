---

description: "Detailed implementation task list for Sorakada 006 Workspace filesystem synchronization"

---

# Tasks: Workspace Filesystem Synchronization

**Input**: `specs/006-workspace-filesystem-sync/spec.md` and `plan.md` on the current `feature-core` baseline.

**Prerequisites**: 003 Workspace/Explorer and 005 opened-document external-change implementation are already present. 006 deliberately reuses them; do not substitute a new Explorer manager, watcher stack, document lifecycle, path ownership system, or UI framework.

**Tests**: Required. 006 is primarily filesystem race/convergence/data-safety behavior, and the repository Constitution requires deterministic tests plus the four repository gates. Write/extend the listed tests before or alongside each implementation slice; avoid making correctness depend on live OS timing.

**Implementation discipline**: Tasks below are intentionally explicit for an implementation agent. When a task says reuse/extend an existing module, do not create an alternative architecture. If repository paths have moved, resolve the current equivalent first and preserve ownership boundaries from `plan.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Safe to work in parallel with adjacent tasks because it targets different files/independent tests.
- **[Story]**: Maps to one frozen user story (`US1`–`US6`). Setup/foundation/final audit tasks have no story label.
- Every task names the concrete file(s) to edit or inspect.

---

## Phase 1: Setup & Baseline Audit (Shared Infrastructure)

**Purpose**: Lock the implementation to the current `feature-core` architecture before changing behavior. These tasks are intentionally code-aware: do not recreate modules that already exist and do not reinterpret the frozen design.

- [X] T001 Read `specs/006-workspace-filesystem-sync/spec.md`, `plan.md`, `.specify/memory/constitution.md`, `AGENTS.md`, and the current 003/005 specs; record the 006 superseded rules (003 FR-028/FR-082/FR-087 + cached re-expansion behavior) as implementation constraints before editing code.
- [X] T002 Verify the plan aliases still resolve to the current files in `src/app/`, `src/services/`, and `src-tauri/src/`; if a file moved, use its actual replacement and DO NOT create a duplicate manager/service just to match the plan.
- [X] T003 Run the pre-change quality gates from repository root — `npm run typecheck`, `npm run test`, `npm run build`, then `cargo test` in `src-tauri/` — and treat any pre-existing failure as a baseline issue rather than silently weakening 006 tests.
- [X] T004 [P] Audit existing watcher/Explorer tests in `src/services/filesystemWatcher.test.ts`, `src/app/document/openedDocumentWatchCoordinator.test.ts`, `src/app/explorer/explorerController.test.ts`, `src/app/explorer/explorerActions.test.ts`, and Rust watcher/workspace tests; reuse their fakes/schedulers where possible instead of introducing a second testing framework.

**Checkpoint**: Complete T001–T004 and keep the relevant targeted tests green before proceeding.

---

## Phase 2: Foundational Identity, Watcher Coverage & Reconciliation Primitives

**Purpose**: Build the safety foundations that every user story depends on. No recursive Workspace watch should be enabled in App until this phase is complete and green.

- [X] T005 Add failing Rust tests in `src-tauri/src/file_identity.rs` for a new optional opaque filesystem-object identity: same object keeps the token across an in-filesystem rename; delete/recreate at the same path does not reuse the old token on the primary supported platform; unsupported identity returns `None` rather than inventing continuity.
- [X] T006 Implement the platform-neutral opaque filesystem-object identity helper in `src-tauri/src/file_identity.rs`; on Windows derive it from stable native metadata (volume identity + file index/file id available through the current Rust toolchain), use an equivalent device/inode identity where supported elsewhere, and keep the representation private/opaque above Rust.
- [X] T007 Extend `ResolvedPathIdentity` in `src-tauri/src/file_identity.rs` with `object_identity: Option<String>` for the resolved target object, populate it for existing files/directories, keep missing destinations `None`, and do not change `comparison_key` semantics or hard-link/path ownership behavior.
- [X] T008 [P] Extend the existing Rust serialization assertions for `ResolvedPathIdentity` in `src-tauri/src/commands/file.rs` and/or colocated file-identity tests so the JSON field is exactly `objectIdentity` and nullable; preserve all existing wire fields.
- [X] T009 Add Rust tests in `src-tauri/src/workspace_fs.rs` proving one-level directory reads return a stable object identity for each entry without recursively reading descendants; cover ordinary file, directory and symlink/junction entry metadata where the fixture/platform supports it.
- [X] T010 Extend `WorkspaceDirectoryEntry` production construction in `src-tauri/src/workspace_fs.rs` and its command DTO in `src-tauri/src/commands/workspace.rs` with nullable `objectIdentity`; obtain identity from entry metadata only and do not read file contents or recurse to descendants.
- [X] T011 [P] Update TypeScript identity DTOs in `src/services/fileService.ts` and `src/services/workspaceFileService.ts` with `objectIdentity: string | null`, keeping the token opaque (no parsing, case folding or path ownership based on it).
- [X] T012 [P] Update `src/services/workspaceFileService.test.ts` and relevant `src/services/fileService.test.ts`/existing file-service contract tests to pin the new `objectIdentity` field and nullable fallback from the Tauri boundary.
- [X] T013 [P] Update test fixture builders across `src/app/document/documentManager.test.ts`, `src/app/document/diskValidation.test.ts`, `src/app/explorer/explorerController.test.ts`, and `src/app/explorer/explorerActions.test.ts` so existing identities/listings explicitly provide realistic `objectIdentity` or `null`; avoid `as any` shortcuts that would hide contract drift.
- [X] T014 Add deterministic Rust tests in `src-tauri/src/filesystem_watcher.rs` for the legal mixed-scope case where a non-recursive 005 subscription and recursive 006 subscription share the same canonical watched directory in both subscription orders; assert recursive descendant coverage is never downgraded.
- [X] T015 Add Rust tests in `src-tauri/src/filesystem_watcher.rs` for removing the last recursive subscriber while non-recursive subscribers remain, and for removing non-recursive subscribers while recursive coverage remains; assert remaining subscriptions still route only events matching their own scope.
- [X] T016 Add Rust tests in `src-tauri/src/filesystem_watcher.rs` for backend scope-reconfiguration failure/rollback and lost-completeness invalidation: an attempted recursive upgrade must not be reported live unless coverage exists, and existing consumers must receive safe invalidation/degraded behavior when a reconfigure gap cannot be proven complete.
- [X] T017 Refactor `WatchRecord` bookkeeping in `src-tauri/src/filesystem_watcher.rs` to track per-scope demand and an effective backend scope rather than “first subscription chooses scope”; effective coverage MUST be recursive whenever any recursive subscriber exists.
- [X] T018 Implement backend scope transition logic in `src-tauri/src/filesystem_watcher.rs` so upgrading/downgrading one directory never holds the core mutex while calling the native backend, preserves the current deadlock-avoidance rule, and rolls back/invalidates safely on native watch/unwatch failure.
- [X] T019 Keep per-subscription routing in `src-tauri/src/filesystem_watcher.rs` scope-specific after backend promotion: a recursively watched backend may emit deep events, but a 005 `NonRecursive` subscription still receives only its concrete direct target while the 006 `Recursive` subscription receives descendants. For every emitted change payload, compute nullable `relativePath` and `renameTargetRelativePath` from that subscription's canonical `watchedPath` with the existing platform-aware Rust containment helper; an outside rename target has no relative target path but may keep its raw target.
- [X] T020 Fix global/path-specific invalidation generation in `src-tauri/src/filesystem_watcher.rs` without changing the wire shape: derive/deduplicate invalidations from live logical subscriptions as `(scope, watchedPath)` pairs rather than the promoted backend `WatchRecord` scope; an empty-path/global backend loss emits the currently affected logical pairs so both 005 non-recursive and 006 recursive consumers receive their own relevant invalidation.
- [X] T021 Preserve `WatchInvalidated { scope, watchedPath, reason }` while extending `WatchEvent` in `src-tauri/src/watch_event.rs` / `src/services/filesystemWatcher.ts` with nullable `relativePath` + `renameTargetRelativePath`; add synchronized Rust/TypeScript serialization/decoder tests. Also update `src/app/document/openedDocumentWatchCoordinator.ts` + tests to discard recursive-only invalidations that do not intersect current 005 interests before `WatchEventNormalizer.push()`; 005 ignores the new relative-path fields and a 006-only invalidation must not trigger 005-wide validation.
- [X] T022 Extend the real/native watcher coverage test in `src-tauri/src/filesystem_watcher.rs` with one bounded recursive descendant observation test, but keep all mixed-scope/refcount/reconfiguration correctness tests synthetic through `RecordingBackend` so the suite does not depend on OS timing.
- [X] T023 Run targeted Rust watcher tests after the mixed-scope refactor and verify 005 non-recursive tests remain unchanged semantically before proceeding to Workspace consumer work.
- [X] T024 [P] Create `src/app/explorer/explorerReconciliation.test.ts` first with pure failing cases for unchanged entry, add, remove, same-parent rename, Windows case-only rename, cross-parent move, kind mismatch, null object identity fallback, delete/recreate with a different object identity, and ambiguous duplicate object identities (hard-link-like entries) that MUST NOT be collapsed into a guessed relocation.
- [X] T025 Create `src/app/explorer/explorerReconciliation.ts` as a pure module that diffs old represented children against fresh direct-child listings, matches relocation only by equal non-null `objectIdentity` + compatible kind, and never uses content/size/timestamp/name similarity as rename proof.
- [X] T026 Extend `ExplorerEntry`/directory/file/other nodes in `src/app/explorer/explorerModel.ts` with nullable `objectIdentity` and update `toExplorerNode`, sorting and fixture helpers without making physical identity the logical Tree-node key; update the existing direct-create path in `src/app/explorer/explorerActions.ts` so a successful New File/New Folder inserts `created.identity.objectIdentity` into the new `WorkspaceDirectoryEntry` instead of creating a temporary identity-less node.
- [X] T027 Refactor `mergeChildren` or replace it with the identity-aware pure reconciliation result from `src/app/explorer/explorerReconciliation.ts`; preserve surviving node objects/cache only when path is unchanged or object identity proves relocation, and treat unproved path replacement as a fresh node.
- [X] T028 [P] Add tests in `src/app/explorer/explorerReconciliation.test.ts` proving two logical symlink/hard-link-like nodes may share a physical identity without global deduplication, identity matching is limited to the current reconciliation batch, and duplicate candidates require explicit source/target narrowing before continuity can be claimed.
- [X] T029 [P] Add pure helper coverage for subtree path rebasing in `src/app/explorer/explorerController.test.ts`/`explorerReconciliation.test.ts`: a confirmed directory relocation preserves cached descendants and recomputes paths without a disk walk, including selection suffix handling.
- [X] T030 Run frontend tests for identity DTOs and pure Explorer reconciliation; do not enable Workspace watching until all Phase 2 tests pass.

**Checkpoint**: Complete T005–T030 and keep the relevant targeted tests green before proceeding.

---

## Phase 3: User Story 1 - Automatic External Create/Delete Synchronization (Priority: P1) 🎯 MVP

**Purpose**: Add one Workspace watcher consumer and one canonical Explorer reconciliation path so loaded structure updates automatically for external Create/Delete without recursive scanning.

**Goal**: Externally created/deleted children of the root or an already-loaded directory converge automatically; never-loaded descendants remain untouched.

**Independent Test**: Open a Workspace, expand `src`, inject/create/delete direct children, and assert automatic convergence while a never-loaded nested directory is never read.

- [X] T031 [P] [US1] Create failing per-directory reconciliation coordination tests in `src/app/explorer/explorerController.test.ts`: duplicate background requests share one in-flight read, a hint during the read marks `dirtyAgain` and causes at most one necessary follow-up read, and a newer per-node generation prevents an older completion from applying.
- [X] T032 [US1] Refactor `src/app/explorer/explorerController.ts` so `loadRoot`, first expansion, watcher reconciliation, periodic reconciliation and Manual Refresh all call one internal directory-read/reconcile primitive; keep `ExplorerController` as the sole mutable Tree owner.
- [X] T033 [US1] Add a public/narrow `reconcileDirectory(path, source/priority)` (or equivalent port) in `src/app/explorer/explorerController.ts` that only accepts represented directories, never recursively loads children, and exposes a deterministic completion/result seam for the Workspace coordinator.
- [X] T034 [US1] Implement per-node in-flight/dirty-again/request-generation bookkeeping in `src/app/explorer/explorerController.ts`; preserve the existing WorkContext generation check and ensure inability to cancel native I/O only makes a stale result non-committable.
- [X] T035 [P] [US1] Add tests in `src/app/explorer/explorerController.test.ts` proving collapse during reconciliation stays collapsed, a read may update cache without reopening the node, and a removed parent invalidates pending descendant reads so they cannot repopulate the subtree.
- [X] T036 [P] [US1] Create `src/app/workspace/workspaceWatchBatcher.test.ts` with a fake scheduler and failing cases for one change, duplicate paths, create+delete burst, paired rename source/target preservation, invalidation-only batch, disposal, and a non-restarting coalescing window.
- [X] T037 [US1] Implement `src/app/workspace/workspaceWatchBatcher.ts` as a Workspace-specific reducer over `WatchEventPayload`; collect raw count/unique paths/rename candidates/invalidation but do not consult DocumentManager, mutate Explorer, or reuse the document-specific `WatchEventNormalizer` key model.
- [X] T038 [P] [US1] Create `src/app/workspace/workspaceWatchCoordinator.test.ts` with fakes for `FilesystemWatcherService`, WorkContext snapshots, Explorer reconciliation and timers; first cover recursive root subscription start, post-subscription root reconciliation/read-gap closure, event listener registration, and close/replacement disposal with generation-safe stale callback rejection.
- [X] T039 [US1] Implement `src/app/workspace/workspaceWatchCoordinator.ts` lifecycle skeleton: subscribe/listen through the existing `FilesystemWatcherService`, request `scope: "recursive"` for the committed root, retain the Workspace subscription id/handle, ignore ordinary Change payloads belonging only to 005 document subscriptions, accept only invalidations for the current recursive root/logical global equivalent, capture WorkContext id/generation + watch generation, make `start()/dispose()` restart-safe under React Strict Mode, and after subscription activation request one generation-safe root reconcile when the Explorer already represents that context (otherwise rely on the later normal initial root load). Workspace path lookup MUST use the event's subscription-relative path rebased under `WorkContext.rootPath`, never raw watcher-path equality.
- [X] T040 [US1] Add a narrow Explorer query surface in `src/app/explorer/explorerController.ts` for “is this directory represented/loaded?” and current represented root; the Workspace coordinator may query this metadata but MUST NOT mutate node records directly.
- [X] T041 [US1] Implement normal hint-to-directory mapping in `src/app/workspace/workspaceWatchCoordinator.ts`: rebase `relativePath` onto the logical Workspace root first, then target its direct parent; a paired in-root `renameTargetRelativePath` targets the logical destination parent, while an outside raw rename target is document-only and never used for Tree lookup. Only represented/loaded logical parents are scheduled, so events under never-loaded directories create zero background reads.
- [X] T042 [P] [US1] Add coordinator tests proving events under an unloaded directory are ignored structurally, while a direct hint for a loaded-but-collapsed parent still schedules its one-level reconciliation.
- [X] T043 [US1] Wire the Workspace coordinator in `src/app/App.tsx` beside (not inside) `OpenedDocumentWatchCoordinator`; share `tauriFilesystemWatcher`, `workContext` and `controller`, start it after app subscriptions are installed, and dispose it in the same effect cleanup without changing existing 005 startup/cleanup.
- [X] T044 [P] [US1] Add an App-level/module-boundary assertion in `src/app/document/openedDocumentWatchCoordinator.test.ts` or the new Workspace coordinator test that 005 document watcher sources do not import Workspace/Explorer modules and 006 does not mutate DocumentSession directly.
- [X] T045 [P] [US1] Add external Create/Delete integration-style tests in `src/app/workspace/workspaceWatchCoordinator.test.ts` + `src/app/explorer/explorerController.test.ts`: root child add/remove, loaded child add/remove, entire represented subtree delete, and successful Sorakada New File/New Folder followed by repeated watcher echoes yielding exactly the on-disk nodes with no duplicate/missing entry.
- [X] T046 [US1] Verify external deletion of an open file only removes Explorer structure in the 006 tests and leaves document close/missing semantics to existing 005 tests; do not call `removeDeletedSessions`/ordinary close from the Workspace watcher path.
- [X] T047 [US1] Run targeted frontend tests for Explorer + Workspace watcher and confirm User Story 1 works with a synthetic recursive event stream before implementing relocation continuity.

**Checkpoint**: Complete T031–T047 and keep the relevant targeted tests green before proceeding.

---

## Phase 4: User Story 2 - Confirmed External Rename/Move Continuity (Priority: P1)

**Purpose**: Use filesystem-object identity to preserve Tree/document continuity only when the source/destination are provably the same object, while keeping 005 content validation authoritative.

**Goal**: Confirmed external rename/move preserves logical Tree and open-document state; unconfirmed/conflicting relocation safely degrades without guessing or duplicate ownership.

**Independent Test**: Externally rename/move clean and dirty open files plus a directory containing open files; verify identity/state continuity, conflict rejection, and 005 validation at the new path.

- [X] T048 [P] [US2] Extend failing `src/app/explorer/explorerReconciliation.test.ts` cases so a batch containing source and destination parent snapshots produces a confirmed cross-parent relocation only when the removed/added entries share the same non-null object identity; a paired rename hint with mismatching identity must still be remove+add.
- [X] T049 [US2] Extend `src/app/explorer/explorerReconciliation.ts` to reconcile a bounded set of parent snapshots together and return explicit `ConfirmedExplorerRelocation` facts (`kind`, old path, new path, object identity) separately from ordinary additions/removals.
- [X] T050 [US2] Add `ExplorerController.reconcileDirectories(...)` or equivalent batched apply in `src/app/explorer/explorerController.ts` so source+target parents can be read under one WorkContext generation, relocation matching is computed from pre-apply snapshots, and stale batch generation applies nothing.
- [X] T051 [US2] Implement confirmed same-parent rename apply in `src/app/explorer/explorerController.ts`: reuse existing node object, update name/path/object identity, preserve directory load/cache/expanded state, resort siblings, and follow selection when it points at/under the relocated node.
- [X] T052 [US2] Implement confirmed cross-parent move apply in `src/app/explorer/explorerController.ts`: detach/reinsert the same node, rebase cached subtree paths, preserve compatible expansion/cache, and invalidate old-path read tokens so a late old-path read cannot reinsert the node.
- [X] T053 [P] [US2] Add case-only Windows rename tests in `src/app/explorer/explorerController.test.ts` proving display/path casing updates even when comparison keys would compare equal.
- [X] T054 [US2] Add identity-aware external relocation result types/ports to `src/app/document/documentManager.ts` without exposing mutable sessions to Workspace code; name the domains explicitly so `entryObjectIdentity` is Tree-entry continuity evidence while `resolvedTargetObjectIdentity` belongs to the current document binding, and design the API around explicit old binding/path + new path with structured per-document outcomes.
- [X] T055 [P] [US2] Add failing `src/app/document/documentManager.test.ts` cases for external file relocation: clean and dirty sessions preserve id/editor state/history/dirty; path ownership index moves exactly once; binding generation advances; active Tab does not change; no text reload occurs in this method.
- [X] T056 [US2] Implement external file relocation adoption in `src/app/document/documentManager.ts`: preflight the current binding, derive the expected `resolvedTargetObjectIdentity` from that still-current binding, wait/retry compatible pending path operations, inspect the destination and require its resolved-target identity to match, reject existing/pending conflicting ownership, then commit path/display/path index/binding generation atomically. Never compare or substitute a symlink/no-follow `entryObjectIdentity` for the document target identity.
- [X] T057 [P] [US2] Add `src/app/document/documentManager.test.ts` cases where the external target is already open, reserved by Save As/Open/internal Rename, or source binding became stale; assert no merge, no stolen ownership, no old-path index corruption and a structured rejected/superseded outcome.
- [X] T058 [US2] Extend DocumentManager external relocation to directory-prefix requests in `src/app/document/documentManager.ts`: enumerate only current open sessions under the old canonical source prefix, derive each new suffix path, preflight each destination, and return per-session adopted/rejected results without recursively walking the filesystem.
- [X] T059 [P] [US2] Add directory-relocation tests in `src/app/document/documentManager.test.ts` with multiple clean/dirty sessions; prove unaffected outside sessions stay unchanged and one conflicting descendant can remain unadopted without allowing duplicate destination ownership for other adopted descendants.
- [X] T060 [US2] Ensure successful external relocation in `src/app/document/documentManager.ts` emits the existing `WatchInterestChange` rebound (or a minimal extension of it) so 005 migrates subscription through its current interest lifecycle; do not call watcher service directly from DocumentManager.
- [X] T061 [P] [US2] Add an explicit `external-relocation` validation trigger/reason in `src/app/document/diskValidation.ts` and tests in `src/app/document/diskValidation.test.ts` that force a supported content snapshot check after relocation instead of trusting the just-resolved target metadata as an already-adopted baseline.
- [X] T062 [US2] Extend `src/app/document/openedDocumentWatchCoordinator.ts` to recognize a rebound caused by confirmed external relocation and run the forced post-relocation validation after the new subscription is established; keep ordinary Save As/internal Rename registration behavior unchanged.
- [X] T063 [P] [US2] Add tests in `src/app/document/openedDocumentWatchCoordinator.test.ts` for the race where 005 first observes old path `missing`, then 006 rebinds to a confirmed new path: post-relocation validation must resolve to clean/normal only if disk content still matches baseline, and a dirty divergent target must become `modified` without replacing the buffer.
- [X] T064 [P] [US2] Add tests covering clean external relocation with content changed during the move: forced validation reloads clean document through existing `applyValidatedDiskSnapshot`; 006 itself never writes/replaces EditorState.
- [X] T065 [US2] Update `WorkspaceWatchCoordinator` in `src/app/workspace/workspaceWatchCoordinator.ts` to consume `ConfirmedExplorerRelocation` facts after Explorer apply and request DocumentManager file/directory relocation using old/new paths plus explicitly named entry-domain evidence only; it MUST NOT pass or relabel `entryObjectIdentity` as the document's expected target identity. When a paired rename/move candidate has an unrepresented/outside target parent, do not load that Tree branch; instead allow a document-only relocation attempt whose target path and `resolvedTargetObjectIdentity` are independently proven by DocumentManager. Rejected/document-only outcomes must never roll back Explorer disk truth.
- [X] T066 [P] [US2] Add coordinator/document tests in `src/app/workspace/workspaceWatchCoordinator.test.ts` and `src/app/document/documentManager.test.ts` for: move within Workspace with both parents represented; logical Workspace root opened through an equivalent/symlink spelling where canonical raw watcher paths still map to the correct Tree parents via relative paths; relocation of an open file reached through a symlink where `entryObjectIdentity` differs from `resolvedTargetObjectIdentity`; move within/out of Workspace where the target parent is unrepresented but a paired source/target candidate lets DocumentManager prove and adopt an open document without loading that target Tree branch; opportunistic move-in adoption only when a source+target candidate is actually available; and fallback to remove/create/005 missing behavior when target/object proof is unavailable.
- [X] T067 [P] [US2] Add tests proving a confirmed dirty file relocation follows the new path without prompting and preserves dirty text/history, while 005 validation still decides whether external content conflict exists at the new target.
- [X] T068 [P] [US2] Add a regression in `src/app/document/documentManager.test.ts` proving native `objectIdentity` never replaces `comparisonKey` in `openPathIndex` or destination reservation logic; distinct hard-link/canonical-path semantics from 002/003 remain unchanged.
- [X] T069 [US2] Run focused document/watcher/Explorer tests and verify User Story 2 before adding overflow/periodic behavior, because later recovery must build on the same relocation semantics.

**Checkpoint**: Complete T048–T069 and keep the relevant targeted tests green before proceeding.

---

## Phase 5: User Story 3 - Event Loss, Reordering & Final Convergence (Priority: P1)

**Purpose**: Make watcher noise and lost completeness a bounded request for filesystem truth rather than a replay log.

**Goal**: Duplicate/reordered/overflowed streams converge to current represented filesystem state and do not create parallel read storms.

**Independent Test**: Inject noisy batches and invalidation with deterministic scheduler/readers and compare final Explorer structure to authoritative directory listings.

- [X] T070 [P] [US3] Add failing `src/app/workspace/workspaceWatchBatcher.test.ts` cases for high raw-event count, many duplicate paths, continuous input across a non-restarting window, invalidation during a path burst, and threshold transition to `requiresRecovery` while dropping unnecessary fine-grained detail.
- [X] T071 [US3] Implement centralized batch/storm thresholds in `src/app/workspace/workspaceWatchBatcher.ts`; once a batch is in recovery mode, retain only the bounded metadata needed to trigger recovery and never let raw-event arrays grow without bound.
- [X] T072 [P] [US3] Add `WorkspaceWatchCoordinator` tests in `src/app/workspace/workspaceWatchCoordinator.test.ts` for reordered Create/Delete/Rename hints where the fake filesystem already holds the final state; assert only reconciliation result matters and no event-log replay mutation occurs.
- [X] T073 [US3] Implement invalidation/overflow handling in `src/app/workspace/workspaceWatchCoordinator.ts`: discard trust in fine-grained event sequence and schedule recovery for root + currently expanded represented directories, not every historical loaded directory.
- [X] T074 [US3] Expose a read-only `listExpandedDirectoryPaths()`/equivalent from `src/app/explorer/explorerController.ts` that returns represented directory paths only; keep Tree records private and never use it to recursively discover unloaded descendants.
- [X] T075 [P] [US3] Add coordinator tests proving overflow recovery excludes a loaded-but-collapsed directory and includes root + expanded descendants, even if hundreds of collapsed cached nodes exist.
- [X] T076 [P] [US3] Add tests in `src/app/explorer/explorerController.test.ts` for a hint arriving during in-flight read: `dirtyAgain` causes a bounded follow-up and a burst of many hints before completion still does not start one read per hint.
- [X] T077 [P] [US3] Add Manual Refresh race tests in `src/app/explorer/explorerController.test.ts`: explicit Refresh cancels inline edit, rereads all loaded nodes including collapsed, increments/supersedes apply generation, and an older watcher read completing afterwards cannot overwrite the Refresh result.
- [X] T078 [US3] Refactor `ExplorerController.refresh()` in `src/app/explorer/explorerController.ts` to use the canonical reconciliation primitive while preserving all 003 semantics (all loaded nodes, collapsed included, selection preservation/clearing, root error handling, inline edit cancellation).
- [X] T079 [P] [US3] Add a coordinator/read integration test for rapid Create->Delete yielding no visible intermediate node when final direct listing contains neither entry, and Delete->Recreate with a new object identity yielding a fresh node rather than inherited relocation state.
- [X] T080 [P] [US3] Add stale-subtree tests where a parent delete is reconciled before a child read returns; invalidate child read tokens/queue entries in `src/app/explorer/explorerController.ts` and prove the child completion applies nothing.
- [X] T081 [P] [US3] Add sequential rename (`a -> b -> c`) tests in `src/app/explorer/explorerReconciliation.test.ts`/coordinator tests showing final provable identity/location wins and intermediate names are not persisted as an event history.
- [X] T082 [P] [US3] Add deterministic shared-stream invalidation regressions for 005 + 006: a logical non-recursive invalidation reaches 005 but is ignored by 006 unless it also affects the recursive root; a logical recursive Workspace invalidation schedules 006 recovery but is ignored by 005; a backend-global loss emits the affected logical scope/path invalidations so both consumers independently recover without directly invoking each other.
- [X] T083 [US3] Run all watcher/Explorer tests with fake timers/schedulers and assert no test depends on arbitrary sleeps for correctness.

**Checkpoint**: Complete T070–T083 and keep the relevant targeted tests green before proceeding.

---

## Phase 6: User Story 4 - Large Workspace / Event-Storm Performance Bounds (Priority: P1)

**Purpose**: Enforce that synchronization cost follows represented state, not total Workspace size or raw watcher event count.

**Goal**: A collapsed huge subtree stays unscanned during watcher start, event storms and periodic fallback; user navigation remains higher priority than background recovery.

**Independent Test**: Use a fake 50k+/100k descendant tree plus a large synthetic event burst to prove no descendant reads are issued for unopened directories and the queue stays bounded.

- [X] T084 [P] [US4] Add deterministic scale tests in `src/app/workspace/workspaceWatchCoordinator.test.ts` using a fake filesystem fixture that models at least 100,000 unopened/collapsed descendants, including at least 50,000 beneath unopened `node_modules`; inject at least 10,000 synthetic hints, assert zero descendant directory read/reconcile calls during watcher startup, ordinary handling and periodic reconciliation, keep batch memory/work requests bounded, then enqueue a user expansion while recovery work remains and prove it completes ahead of the remaining background backlog.
- [X] T085 [P] [US4] Add a represented-tree fixture in `src/app/explorer/explorerController.test.ts` with hundreds of loaded directories, most collapsed, and assert the API used by periodic recovery returns only root + currently expanded directories.
- [X] T086 [US4] Implement scheduler priorities in `src/app/workspace/workspaceWatchCoordinator.ts` (user expansion/manual refresh ownership remains in Explorer; watcher direct hint > overflow/periodic background) so a user-requested represented-directory read cannot sit behind an unbounded background queue.
- [X] T087 [US4] Implement a bounded reconciliation queue/set in `src/app/workspace/workspaceWatchCoordinator.ts` keyed by current context + logical directory path/generation; duplicate pending background requests replace/merge intent rather than append promises.
- [X] T088 [P] [US4] Add tests proving queue deduplication: 10,000 hints for one represented parent create one pending directory key plus bounded follow-up state, not 10,000 scheduled jobs.
- [X] T089 [P] [US4] Add periodic scheduler tests in `src/app/workspace/workspaceWatchCoordinator.test.ts` using injected fake timers: root + expanded directories are requested; loaded-collapsed are skipped; advancing a 60-second idle window causes zero reads of loaded-but-collapsed directories; and a still-running periodic pass causes the next tick to coalesce/skip instead of overlap.
- [X] T090 [US4] Implement low-frequency periodic reconciliation in `src/app/workspace/workspaceWatchCoordinator.ts` using a named default interval (initial target ~10s, injectable in tests); do not expose a Settings UI or hard-code timing assumptions into business tests.
- [X] T091 [US4] Modify cached re-expansion in `src/app/explorer/explorerController.ts`: render existing children immediately, keep expansion responsive, and asynchronously request direct-child reconciliation instead of waiting for periodic/Manual Refresh.
- [X] T092 [P] [US4] Update the former 003 re-expansion tests in `src/app/explorer/explorerController.test.ts` to the 006 superseded contract: no cache discard/flicker, but exactly one bounded reconciliation request on re-expansion; first-time expansion still performs its normal initial read.
- [X] T093 [US4] Add focus-regain wiring in `src/app/App.tsx` so the existing Tauri `onFocusChanged` callback triggers both 005 document validation and a bounded 006 expanded-area reconciliation request; do not await filesystem work in the focus handler.
- [X] T094 [P] [US4] Add coordinator tests for focus regain while a periodic/recovery pass is active, proving work is merged/superseded rather than duplicated; background cadence reduction remains optional and must not add a new settings subsystem.
- [X] T095 [US4] Add a realistic/manual performance validation task script/notes in `specs/006-workspace-filesystem-sync/tasks.md` execution evidence (implementation PR/commit notes, not a new runtime module): open a disposable frontend project, keep `node_modules` collapsed, run package-manager/Git churn, and record that no recursive reads/freeze occur.
- [X] T096 [US4] Run targeted scale tests with timing assertions limited to deterministic scheduler/queue behavior; do not introduce fragile wall-clock UI thresholds into unit tests beyond the spec success criteria.

**Checkpoint**: Complete T084–T096 and keep the relevant targeted tests green before proceeding.

---

## Phase 7: User Story 5 - Workspace/Watcher Lifecycle, Degraded Mode & Root Recovery (Priority: P2)

**Purpose**: Make long-lived watcher/timer work safe across WorkContext replace/close, watcher failures and temporary root loss.

**Goal**: Old Workspace callbacks never affect the current Explorer; watcher failure degrades gracefully; original-root recovery works without auto-following moved roots.

**Independent Test**: Switch/close during pending work, fail/rebuild watcher, move root away and recreate original path; verify state/generations behave exactly as the frozen rules require.

- [X] T097 [P] [US5] Add `src/app/workspace/workspaceWatchCoordinator.test.ts` races where Workspace A subscription/listener/read setup is still awaiting and Workspace B replaces it; assert A handles are stopped/released and all late A callbacks/results are ignored by context/watch generation.
- [X] T098 [US5] Implement WorkContext subscription handling in `src/app/workspace/workspaceWatchCoordinator.ts` so generation is invalidated before stopping old timer/watch; close/replace does not await unrelated pending directory I/O and old work can only finish as stale.
- [X] T099 [P] [US5] Add tests for recursive watch startup failure with a readable root: WorkContext/Explorer stay active, coordinator marks only its internal degraded state, periodic fallback remains scheduled, and no root-unavailable callback fires solely from watcher failure.
- [X] T100 [US5] Implement degraded watcher state/retry in `src/app/workspace/workspaceWatchCoordinator.ts`: failed start or known unusable/reconfigure failure does not block Explorer; later successful root/focus/periodic opportunity may retry one subscription per current watch generation without retry storms. A normal invalidation/rescan keeps a live handle and schedules recovery instead of blindly rebuilding the watcher.
- [X] T101 [P] [US5] Add tests for watcher rebuild where the old event listener/subscription produces a late payload after the new generation is live; assert no duplicate scheduling or stale relocation candidate crosses generations.
- [X] T102 [P] [US5] Add root-read failure/recovery tests in `src/app/explorer/explorerController.test.ts` + coordinator tests: direct root failure sets existing root-unavailable state while retaining WorkContext; a later successful read at the same root clears it and allows watcher retry/reconciliation.
- [X] T103 [US5] Ensure `WorkspaceWatchCoordinator` treats root-self watcher events as optional hints only; periodic/direct root reconciliation in `src/app/workspace/workspaceWatchCoordinator.ts` must be sufficient to notice root disappearance even if the native root watch reports no root-entry event.
- [X] T104 [P] [US5] Add test for externally moving/renaming the Workspace root: original root read fails -> unavailable; coordinator MUST NOT adopt the watcher rename target or mutate `WorkContext.rootPath`/identity.
- [X] T105 [P] [US5] Add test for original root path later reappearing: a successful direct root read recovers the existing WorkContext only when the canonical comparison identity still matches; a retargeted root symlink/junction remains unavailable until explicit Open Folder. Recreating a normal directory at the same canonical path is still ordinary same-root recovery.
- [X] T106 [US5] Keep duplicate Open Folder same-canonical-root behavior in `src/app/workspace/workContextManager.ts` unchanged; add only the minimal integration needed so a successful same-root read can clear root unavailable/re-arm 006 without allocating a new WorkContext id.
- [X] T107 [P] [US5] Add App cleanup/Strict Mode lifecycle tests at coordinator level (not a new React test framework): `start -> dispose -> start` recreates timer/listener/subscription once and a superseded async `start` cannot install into the restarted lifecycle.
- [X] T108 [US5] Audit `src/app/App.tsx` effect dependencies and cleanup so both opened-document watcher and Workspace watcher are disposed exactly once per mounted lifecycle; do not move business state into React just to expose coordinator status.
- [X] T109 [US5] Run lifecycle-focused frontend tests under fake timers and verify no timer/listener remains scheduled after Workspace close or coordinator dispose.

**Checkpoint**: Complete T097–T109 and keep the relevant targeted tests green before proceeding.

---

## Phase 8: User Story 6 - Explorer Interaction State, Symlinks & Mutation Races (Priority: P2)

**Purpose**: Keep background synchronization non-disruptive and harden existing internal destructive actions against external replacement races.

**Goal**: Selection/expansion/inline edit behave predictably, symlink semantics remain logical-position based, and internal Rename/Delete never act on a replacement object.

**Independent Test**: Exercise selection/inline/symlink cases plus an external replacement during internal Rename/Delete confirmation; assert no wrong-object mutation or UI-state reset.

- [X] T110 [P] [US6] Add reconciliation tests in `src/app/explorer/explorerController.test.ts` proving unrelated Create/Delete in the same/other directory preserves current selection, expansion and active inline edit.
- [X] T111 [P] [US6] Add tests proving selected node deletion clears selection, while confirmed rename/move updates selection to the rebased path and preserves descendant selection suffix for directory relocation.
- [X] T112 [P] [US6] Add inline-edit conflict tests in `src/app/explorer/explorerController.test.ts`: if the rename target itself disappears/relocates or its parent subtree vanishes, cancel the edit before apply; an unrelated structural update must leave draft text untouched.
- [X] T113 [US6] Implement the inline-edit validity check in `src/app/explorer/explorerController.ts` as part of reconciliation apply; do not call the broad Manual Refresh `cancelInlineEdit()` path for ordinary watcher/periodic updates.
- [X] T114 [P] [US6] Add symlink/junction reconciliation tests in `src/app/explorer/explorerReconciliation.test.ts` + controller tests: same physical target may remain in two logical Tree positions, ancestor-cycle state stays local, and object identity does not globally collapse nodes.
- [X] T115 [US6] Ensure periodic expanded-directory enumeration in `src/app/explorer/explorerController.ts` includes expanded link nodes by logical path even when their resolved target lies outside the Workspace root; the direct read remains subject to existing ancestor-cycle protection.
- [X] T116 [P] [US6] Add failing `src/app/explorer/explorerActions.test.ts` race cases where Rename/Delete captures a source, waits on confirmation/path coordination, then the same path is externally replaced with a different `objectIdentity`; assert the internal operation does not rename/trash the replacement.
- [X] T117 [US6] Extend `ExplorerActions` operation context/capture in `src/app/explorer/explorerActions.ts` to retain expected source entry identity for Rename/Delete and re-inspect immediately before calling the Rust structural mutation; kind/identity mismatch, missing entry, or a null captured/fresh identity MUST abort before rename/trash, preserve Tree/document state, surface the localized operation failure and request/permit reconciliation.
- [X] T118 [US6] For the pre-mutation source check in `src/app/explorer/explorerActions.ts`, use `WorkspaceFileService.readWorkspaceDirectory(parent)` immediately before the Rust Rename/Delete call, find the selected direct child, and compare its non-null entry `objectIdentity`/kind with the captured source (so a replaced symlink cannot hide behind the same resolved target). Do NOT add a dedicated structural-entry IPC in 006 and do NOT rely solely on `FileService.inspectFilePath`, which follows the final symlink. Preserve current dialog and path-reservation ordering; the conservative null-identity refusal applies only to Rename/Delete and MUST NOT disable browsing, reconciliation, Create, or external remove/create fallback.
- [X] T119 [P] [US6] Add tests in `src/app/explorer/explorerActions.test.ts` and `src/app/workspace/workspaceWatchCoordinator.test.ts` proving: a normal unchanged source with a stable non-null entry identity follows the existing disk-first Rename/Delete path; null captured/fresh identity refuses mutation without changing Tree/document state; trash semantics and dirty-document warning behavior from 003 remain intact; and successful internal Rename/Delete followed by duplicate/reordered watcher echoes converges to exactly the on-disk structure with no duplicate or missing node.
- [X] T120 [P] [US6] Add race tests where external relocation and an internal Save As/Rename/Delete target the same destination; `src/app/document/documentManager.test.ts` must prove existing path operation reservation/generation wins deterministically and stale external adoption cannot steal ownership.
- [X] T121 [US6] Review `src/app/document/internalFsOperationGuard.ts` and its tests to ensure 006 does not introduce event-count/time-based self suppression; only extend it if a concrete external-relocation coordination hook is needed, and keep current captured-hint reconciliation semantics intact.
- [X] T122 [US6] Run all User Story 6 tests and verify automatic reconciliation never calls document text APIs or adds implicit Tab-to-Tree location behavior.

**Checkpoint**: Complete T110–T122 and keep the relevant targeted tests green before proceeding.

---

## Phase 9: Polish, Cross-Feature Consistency & Release Gates

**Purpose**: Finish 006 without broadening scope, then re-run a Speckit-analyze-style cross-document audit and all repository gates.

- [X] T123 [P] Audit source comments/names in `src-tauri/src/filesystem_watcher.rs`, `src/services/filesystemWatcher.ts`, and `src/app/document/openedDocumentWatchCoordinator.ts` that currently say 005/006 never mix scopes or that 006 is purely future; update only stale comments so they describe the now-real shared 006 consumer and mixed-scope invariant.
- [X] T124 [P] Audit `src/app/explorer/explorerController.ts` comments/tests that encode the 003 “cached re-expand never rereads until Refresh” contract and update them to the 006 superseded behavior without changing Manual Refresh breadth.
- [X] T125 Verify no task/code introduced a recursive filesystem walker, Workspace index, global symlink graph, file-content hashing for rename detection, event-history persistence, watcher exclusion/settings UI, or automatic Workspace-root-follow feature; remove any speculative code that did.
- [X] T126 Run a static architecture audit (test or code review) proving `WorkspaceWatchCoordinator` does not import/mutate CodeMirror/DocumentSession internals, `OpenedDocumentWatchCoordinator` remains Explorer-free, and Rust `file_codec.rs` remains the sole byte/text interpreter.
- [X] T127 Run `npm run typecheck` from repository root and fix all type errors without weakening the new identity/reconciliation types with `any`/unchecked casts.
- [X] T128 Run `npm run test` and require all existing 001–005 regressions plus new 006 deterministic tests to pass; specifically review 003 Manual Refresh and 005 external-change tests for accidental semantic drift.
- [X] T129 Run `npm run build` and correct production-only bundling/Tauri typing issues without moving business logic into React components.
- [X] T130 Run `cargo test` in `src-tauri/` and require mixed-scope watcher, object-identity, directory listing and existing file-codec/path tests to pass.
- [X] T131 Perform the manual disposable-project matrix from `plan.md`: large collapsed `node_modules`, package-manager storm, Git structural checkout/reset, file/dir relocation with dirty Tabs, case-only rename, subtree delete, root move/restore, symlink/junction branch, and Workspace switch during active events. **Executed manually by the reporter**; results recorded in the Execution Evidence section.
- [X] T132 Record the four quality-gate results and manual high-risk results in the implementation handoff/PR notes; do not add a runtime telemetry/logging subsystem solely for proof.
- [X] T133 Re-run an analyze-style requirement trace: every `FR-001..FR-118`, all six user stories, all three superseded 003 rules, 005 compatibility constraints and `SC-001..SC-012` must map to implementation/tests; resolve any uncovered requirement before completion.
- [X] T134 Re-check `spec.md`, `plan.md`, and `tasks.md` against 003/005 after implementation: no contradiction may allow recursive Workspace scanning, direct watcher-to-state mutation, guessed rename continuity, duplicate document ownership, or 006 clearing 005 content conflicts.

**Checkpoint**: Complete T123–T134 and keep the relevant targeted tests green before proceeding.

---

## Execution Evidence (implementation handoff)

Recorded by the implementing agent on the `feature-core` working tree, and updated after the manual verification round and each convergence pass (Phases 10–13).

### Four quality gates (T127–T130)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS — 0 diagnostics |
| Frontend tests | `npm run test` | PASS — 23 files, 744 tests |
| Production build | `npm run build` | PASS — `vite build`, no bundling/typing issue |
| Rust tests | `cargo test` (in `src-tauri/`) | PASS — 145 passed, 0 failed |

Baseline before any 006 change was recorded in T003 and was green on all four gates. They were re-run after every convergence/verification change, including the Phase 10–13 convergence fixes, the root-error projection fix below, and once more on the restored tree after each round of mutation checks.

### Deterministic scale/performance evidence (T084–T096)

- `workspaceWatchCoordinator.test.ts` drives a fake filesystem fixture modelling **≥100,000 unopened descendants including ≥50,000 under an unopened `node_modules`**, injects **10,000 synthetic hints**, and asserts that only represented directories are ever reconciled (`< 50` reconciliation calls) and that no never-loaded descendant path is read (SC-002, SC-003, SC-010).
- A burst that trips the storm threshold reconciles **root + currently expanded** directories only, and a loaded-but-collapsed directory stays untouched over an idle periodic window (SC-009).
- 10,000 hints for one represented parent produce exactly **one** pending directory key and one drain, not one job per event (FR-068, FR-106).
- Focus regain is merged into a periodic pass that is already in flight instead of starting a second concurrent sweep (FR-094).
- All timing is injected (`WorkspaceScheduler` / `HintScheduler`); no test depends on wall-clock behaviour, sleeps or real timers (T083, T096).

### Manual disposable-project acceptance matrix (T131 / T141)

**Evidence class: reporter confirmation.** The eight `plan.md` scenarios were executed by the reporter on a real Windows desktop session (`npm run tauri dev`, disposable project) and reported complete; the only defect they surfaced is documented below and was re-verified after its fix. No per-scenario observation log, screenshot, timing measurement or environment inventory was captured into this repository, and the implementing agent did not observe the matrix itself — so each row below records *who verified it and how*, not an artifact held here. A reviewer who needs per-scenario artifacts for release sign-off must capture them; the repository holds none.

| # | Manual scenario | Result (evidence) | Deterministic coverage standing in |
|---|---|---|---|
| 1 | Large collapsed `node_modules` + real package-manager storm | PASS — reporter confirmation, no artifact | 100,000-descendant fixture with 10,000 hints and periodic passes; zero reads of the unopened subtree (`workspaceWatchCoordinator.test.ts` SC-002/SC-003) |
| 2 | `git checkout` / `reset --hard` structural churn | PASS — reporter confirmation, no artifact | Noisy/reordered/duplicate hint batches converging from the final listing; overflow recovery bounded to root + expanded (SC-004, SC-010) |
| 3 | File and directory relocation with clean/dirty Tabs | PASS — reporter confirmation, no artifact | `documentManager.test.ts` external-relocation cases: clean and dirty sessions keep id/editor state/history/dirty; directory relocation rebases open descendants; conflict rejection; equivalent-case derivation (T151) |
| 4 | Case-only Windows rename | PASS — reporter confirmation, no artifact | `foo.ts` → `Foo.ts` proven by identity at both the reconciliation and the document level, including the forced post-relocation validation (`explorerReconciliation.test.ts`, `explorerController.test.ts`, `documentManager.test.ts`, `openedDocumentWatchCoordinator.test.ts`) |
| 5 | Whole-subtree delete | PASS — reporter confirmation, no artifact | Represented-subtree removal as one structural result, with descendant completions invalidated (`explorerController.test.ts`) |
| 6 | Workspace root move and restore | PASS — reporter confirmation, no artifact | `explorerController.test.ts` root-identity cases: a retargeted root is refused and keeps `rootUnavailable`; restoring the original directory recovers |
| 7 | Junction/symlink branch, including an outside-root target | PASS — reporter confirmation, no artifact | Two logical positions sharing one object stay separate nodes; an expanded link is swept by its logical path (`explorerReconciliation.test.ts`, `explorerController.test.ts`) |
| 8 | Workspace switch/close during active events | PASS — reporter confirmation, no artifact | Workspace A handshake/batch windows discarded on replacement; zero stale nodes or relocations in B (SC-007) |

**Defect found by the matrix (fixed, re-verified):** after the Workspace root was removed on disk, a Refresh rendered the raw filesystem error *inside* the tree (`Cannot read directory … (os error 2)`), which overlapped the root row and the cached children. Root read failures are now projected once through the panel-level unavailable notice (non-root failures keep their localized node message), and load notices grow instead of being clipped to a fixed row height. The reporter re-confirmed the rendering afterwards.

**Limitations of this record** (also the T153 answer): scenario outcomes rest on the reporter's statement; the environment (Windows build, project size, package manager, filesystem type) was not recorded; scenarios 1, 2 and 8 are the ones the deterministic suite can least substitute for, because UI responsiveness, real `notify` loss/overflow and process-level lifecycle behaviour are only observable on a live desktop. If the release gate requires captured evidence for those three, they must be re-run with logging.

The deterministic suites remain the regression safety net for each row; the manual result is what confirms the parts they cannot observe (UI responsiveness under a real storm, real watcher loss/overflow, real filesystem identity, junction behaviour).

### Manual high-risk results (T132)

- Root path moved to a different canonical target: the Explorer refuses to adopt it and keeps `rootUnavailable` until the original directory returns (FR-097, FR-098) — covered by `explorerController.test.ts` "root identity" cases.
- Watcher subscription failure with a readable root: internal degraded state only, periodic fallback armed, later focus/periodic opportunity retries and recovers (FR-007, FR-008, FR-099) — covered by the coordinator degraded-mode cases.
- Internal Rename/Delete race against an externally replaced object: refused before the Rust call, Tree and documents untouched (FR-066) — covered by `explorerActions.test.ts`.

### Phase 10 convergence (T135–T144)

| Task | Change | Evidence |
|---|---|---|
| T135 | Background reconciliation now requires a directory to be represented **and already read**; a never-opened row (collapsed `node_modules`) is never loaded by a hint | `WorkspaceExplorerPort.isDirectoryRead`; coordinator cases for a never-read directory (zero work) and a loaded-but-collapsed one (FR-075 still reconciled) |
| T136 | Subscription handshakes and batch windows are stamped with the served WorkContext token; a late handle is stopped, a retired window is dropped, and the replacement context's own handshake is restored | coordinator cases "stops a handshake that resolves after its Workspace was replaced" and "drops a batch window that was opened under the previous Workspace" |
| T137 | A relocation rebound is announced on any path change (case-only included) and the relocation cause is handled before the same-key early return, so the forced 005 snapshot read still runs | `documentManager.test.ts` case-only rebound case; `openedDocumentWatchCoordinator.test.ts` clean-reload and dirty-`modified` case-only cases |
| T138 | An inline rename whose own target moved is cancelled instead of rebased; an inline create still follows its relocated parent | `explorerController.test.ts` inline-editor-across-relocation cases |
| T139 | `adoptExternalRelocation` emits the document snapshot once a successful adoption settled | `documentManager.test.ts` snapshot-stream case |
| T140 | Deterministic proof that a user-requested read settles ahead of the remaining recovery backlog, and that the bounded queue keeps the strongest intent | coordinator scheduling-priority cases (SC-003) |
| T141 | Manual acceptance matrix executed by the reporter and recorded above | this section |
| T142 | Hundreds of loaded, mostly-collapsed directories through the real `ExplorerController` accessor, fed into a real coordinator periodic pass | controller bounded-sweep case + coordinator "real controller" case |
| T143 | Periodic passes fired over the 100,000-descendant fixture | coordinator SC-002 periodic case |
| T144 | The pre-mutation source check locates the child by leaf name (case-insensitive) before requiring identity equality | `explorerActions.test.ts` "still renames when only the on-disk leaf casing changed" |

### Phase 11 convergence (T145–T153)

| Task | Change | Evidence |
|---|---|---|
| T145 | Continuity now requires *equal non-null* object identities: a same-path listing whose identity is unavailable is a replacement, so a delete/recreate cannot inherit the old node, its cache, selection or inline edit (FR-034, FR-042) | `explorerReconciliation.ts` `identityContinuity`; pure cases "same-path entry with no identity on either side"/"one-sided identity"; controller case "gives a same-path identity-less entry a fresh node with no inherited state" |
| T146 | The whole decide → native call → confirm sequence is serialized by a dedicated transition guard, so an overlapping subscribe cannot ride on coverage another attempt never established and a narrowing stop cannot land after a widening start (FR-009, FR-011) | `FilesystemWatcher::transition` + `GatedBackend`/thread cases "an overlapping subscribe does not ride on an unestablished watch" and "an overlapping resubscribe keeps recursive coverage". Mutation-checked: removing the guard fails **both** tests |
| T147 | Relocation refuses a destination an in-flight Open is about to claim, because a successful Open registers itself as that key's canonical owner (FR-062, FR-063, FR-065) | `documentManager.test.ts` "refuses a destination an in-flight Open is about to claim" |
| T148 | Expanded-area enumeration stops at a collapsed ancestor without clearing stored descendant flags, so periodic/recovery work never reads under a collapsed subtree but re-expansion restores the sweep (FR-074, US4-AC3) | `listExpandedDirectoryPaths` pruning + controller case "does not sweep below a collapsed ancestor but restores it on re-expansion" |
| T149 | A stale drain hands its pending current-generation work to a new drain instead of leaving it queued behind a drain that already exited (FR-100, FR-101) | coordinator case "reconciles the replacement root when a stale drain exits across dispose/start" |
| T150 | The pre-mutation lookup prefers an exact leaf and only accepts a *unique* case-folded candidate whose identity and kind match; ambiguity is refused (Constitution I, FR-066) | `findSourceEntry`; `explorerActions.test.ts` cases "prefers the exact leaf over a case-colliding sibling with the same identity" and "refuses an ambiguous case-folded match instead of guessing" |
| T151 | Relocation candidates and suffixes are derived component-wise under the platform's case rule and verified against the session's own canonical path, with `..` refused (FR-045, FR-058) | `relativeWithinFolded`/`canonicalSuffixMatches`; `documentManager.test.ts` cases for equivalent-case file, equivalent-case nested directory and a genuinely different source location |
| T152 | The SC-009 proof now covers a full 60-second idle window at the named 10-second cadence, with every eligible expanded directory covered and zero reads inside a collapsed subtree | coordinator case "never reads a loaded-but-collapsed directory across a full 60-second idle window (SC-009)" |
| T153 | The release evidence records its own evidence class, environment limitations and the four command results rather than an unqualified PASS | "Manual disposable-project acceptance matrix" section above |

### Post-convergence fix reported during manual verification

Reported from a real session: after the Workspace root was removed on disk, a Refresh rendered the raw filesystem failure *inside* the tree — `Cannot read directory D:\…: 系统找不到指定的文件。 (os error 2)` — painted over the root row and the cached children.

Two independent causes, both fixed:

1. **Content**: the root node no longer carries a read-failure message at all. A root failure is projected exactly once, by the existing panel-level `rootUnavailable` notice, and recovered through Refresh / periodic / focus-regain retries (FR-095). The same rule now applies to the FR-097 retargeted-root condition, whose authored sentence was equally long; `ROOT_RETARGETED_MESSAGE` was removed with it. A **non-root** directory keeps its localized message, which FR-025 requires. Pinned by `explorerController.test.ts`: "keeps a failed root read out of the Tree and localizes a child failure" (the raw `os error 2` message must not reach the root node, cached children survive, and a child failure still shows "Access is denied."), plus the updated root-availability and root-identity cases.
2. **Layout**: `.explorer-row--notice` inherited the fixed `height: 22px` of a normal row while allowing its sentence to wrap, so a long message painted over the rows above and below it. The notice row now grows (`height: auto; min-height: 22px`, top-aligned, `overflow-wrap: anywhere`), so no localized message — root or child — can collide with its neighbours again.

This is a presentation fix plus a projection rule. It was re-verified visually by the reporter after the fix (the root row renders as a single uncluttered line with the panel notice above it and the cached children correctly aligned), which is the only way to confirm alignment: the repository has no component/DOM test framework by design.

### Phase 12 convergence (T154–T155)

| Task | Change | Evidence |
|---|---|---|
| T154 | The case-comparison rule is no longer inferred in TypeScript. Rust now reports the resolved directory's comparison contract — `WorkspaceDirectoryResult.case_sensitive`, derived (at this point) from the platform rule (`PATHS_ARE_CASE_INSENSITIVE = cfg!(windows)`) and strengthened by observed case-colliding names in the same listing — and `findSourceEntry` gates its unique case-folded fallback on that reported value. Exact-spelling matching is kept on every platform; the folded fallback is impossible on a case-sensitive directory (Constitution I, FR-066). *Phase 13 replaced the source of that value with the directory's own rule; the consumer contract here is unchanged* | `workspace_fs.rs` `directory_is_case_sensitive` + `read_directory_reports_the_case_comparison_contract`; wire shape pinned from both sides (`commands/workspace.rs` expects 5 fields incl. `caseSensitive`, `workspaceFileService.test.ts` decodes it); `explorerActions.test.ts` "refuses a case-distinct same-identity sibling on a case-sensitive directory" and "still renames an exactly spelled entry on a case-sensitive directory". The case-sensitive model has to live in the test fake (`caseSensitiveDirectories`) because the host is Windows |
| T155 | Relocation containment is proven on canonical keys only. `resolveRelocationSourceKey` resolves the old path through the existing platform-aware `inspectFilePath(…, allowMissing)` and compares it with the session key using `relativeWithinDirectory`; the suffix therefore comes from real canonical containment rather than a lowercased tail comparison, and `rebasePathUnder`/`respellSuffix` rebuild the destination with the session's own prefix. `relativeWithinFolded` and `canonicalSuffixMatches` were deleted with it. Windows case-only continuity is preserved (the Rust comparison key is still the authority), while an equivalent-casing source on a case-sensitive filesystem, a `..`-escaping relation, a disjoint prefix and a same-tail entry in another directory are all refused (FR-045, FR-056, FR-058) | `documentManager.ts` `resolveRelocationSourceKey`/`isSafeRelocationSuffix`/`respellSuffix`; `documentManager.test.ts` "does not adopt an equivalent-casing source on a case-sensitive filesystem" and "does not adopt a same-tail entry that lives in another directory", alongside the Phase 11 positive/equivalent-case cases which still pass (193 tests in that file). Residual limitation recorded: a relocation whose old path's parent no longer exists is conservatively not adopted — the document stays bound and 005 remains authoritative |

Both tasks were driven by a fresh convergence pass over already-`[X]` work rather than by a failing gate, so each was mutation-checked against the code path it replaced before being recorded here. Reverting `identityContinuity`'s non-null requirement fails the T145 pure/controller cases; removing the `transition` guard fails both T146 concurrency cases; removing the `caseSensitive` gate from `findSourceEntry` fails "refuses a case-distinct same-identity sibling on a case-sensitive directory"; restoring a folded comparison in `resolveRelocationSourceKey` fails "does not adopt an equivalent-casing source on a case-sensitive filesystem"; and restoring a tail-only suffix (`ends with the leaf`) fails "does not adopt a same-tail entry that lives in another directory" plus four broader relocation cases. Every mutated file was restored and the four gates re-run on the restored tree.

### Phase 13 convergence (T156)

| Task | Change | Evidence |
|---|---|---|
| T156 | The case rule is now a property of the **directory** instead of the platform. `file_identity::directory_case_sensitive` reports a directory's own rule: on Windows the `FileCaseSensitiveInfo` flag read through a handle opened for attribute queries only (no descendant listing, no content), elsewhere the authoritative platform rule. An answer the platform cannot give resolves conservatively to *case-sensitive*. One shared component-aware contract now feeds all four consumers: `WorkspaceDirectoryResult.caseSensitive` (`workspace_fs::directory_comparison_contract`, still strengthenable but never loosenable by direct case-collision evidence), `comparison_key` for resolved *and* missing-candidate paths, `relative_within` containment, and therefore the relocation source keys derived from them. The pre-mutation source check and the case-only rename authorization read the same contract rather than folding on their own (Constitution I, FR-038, FR-066) | `file_identity.rs`: `CaseComparator`/`PlatformCaseComparator`, `directory_case_sensitive(_with)`, the single `folded_name` primitive, and the component-walking `comparison_key_with`/`relative_within_with`. Native evidence: `the_directory_rule_matches_what_the_filesystem_actually_does` asks the *filesystem itself* whether two case-only-different names can coexist in the directory and requires the reported rule and the platform query to agree with that observation; a case-sensitive directory **model with no pre-existing case-colliding pair** is pinned by `comparison_key_follows_the_rule_of_the_containing_directory` (which also asserts *which* directory governs which component) and `relative_within_uses_the_rule_of_the_directory_containing_each_component`; `an_unreported_directory_rule_is_treated_as_case_sensitive` pins the conservative fallback; `a_case_sensitive_directory_refuses_a_case_only_respelling` pins the rename authorization against the same paths under both answers. IPC: the Rust wire-shape tests keep `caseSensitive` a boolean and `workspaceFileService.test.ts` now also carries a `caseSensitive: true` listing through unchanged (the frontend never re-derives the rule). Frontend regressions: "refuses a case-distinct same-identity sibling on a case-sensitive directory", "still renames an exactly spelled entry on a case-sensitive directory" and — for a directory whose contract the test now asserts as `caseSensitive: false` — "still renames when only the on-disk leaf casing changed", plus the T155 case-distinct relocation refusal |

Mutation-checked in both directions: folding every name again (`PATHS_ARE_CASE_INSENSITIVE` instead of the directory's rule) fails the key test; comparing components under the platform rule fails the containment test; making the fallback non-conservative (`unwrap_or(false)`) fails the conservative-rule test *and* the native agreement test; and dropping the directory check from the rename authorization fails the respelling test. Every mutated file was restored and all four gates re-run on the restored tree.

**Accepted consequence of the conservative fallback**: where a filesystem refuses to report the flag at all (a share or third-party driver that does not implement `FileCaseSensitiveInfo`), the directory is treated as case-sensitive, so a Windows case-only *respell* is refused as "already exists" there instead of being performed. That is the safe direction: refusing a convenience instead of renaming an entry the user did not select. It cannot affect the supported Windows baseline, where the information class exists from Windows 10 1803 — the same baseline Tauri/WebView2 already requires.

---

## Requirement Traceability

This mapping is intentionally explicit so implementation/review agents do not have to infer coverage from phase names alone. Ranges refer to the frozen identifiers in `spec.md`; every item in each range is covered by the listed implementation/test tasks.

| Spec coverage | Primary task coverage | Notes |
|---|---|---|
| FR-001–FR-012 | T014–T023, T038–T043, T097–T109, T123, T130 | Shared watcher reuse, mixed-scope coverage, invalidation routing, Workspace lifecycle/degraded mode |
| FR-013–FR-027 | T024–T047, T070–T083, T121, T124–T126 | Watcher-as-hint, one-level truth, canonical reconcile path, stale/self-event safety |
| FR-028–FR-036 | T031–T047, T079–T080, T110–T113 | External Create/Delete, subtree removal, document/Tree separation, no forced expansion/Tab change |
| FR-037–FR-055 | T005–T013, T024–T030, T048–T069, T103–T106, T114–T115 | Native object identity, proven relocation, hard-link/symlink safety, root non-follow behavior |
| FR-056–FR-067 | T054–T069, T116–T121 | DocumentManager relocation, 005 revalidation, ownership conflicts, internal Rename/Delete replacement race |
| FR-068–FR-083 | T070–T096 | Coalescing/storm recovery, priorities, periodic fallback, cached re-expansion, Manual Refresh preservation |
| FR-084–FR-094 | T110–T126 | Selection/expansion/inline edit preservation, symlink logical positions, silent recovery, architecture boundaries |
| FR-095–FR-104 | T097–T109 | Root unavailable/recovery, watcher retry, close/replace lifecycle and duplicate same-root behavior |
| FR-105–FR-118 | T031–T035, T048–T052, T070–T109, T116–T130 | Shared reconciliation ownership, bounded scheduling, stale generations, mutation serialization, no text/index/crawler scope creep |
| SR-001–SR-003 | T001, T078, T091–T092, T124, T128, T134 | Explicitly superseded 003 external-change/cache rules while preserving Manual Refresh breadth |
| SC-001–SC-004 | T045–T047, T070–T096, T131 | Automatic convergence, explicit 100k/50k collapsed-tree fixture, 10k-hint bounded recovery with user-expansion priority, noisy-stream equivalence |
| SC-005–SC-006 | T048–T069, T120, T131 | File/directory relocation continuity without duplicate ownership or recursive descendant scans |
| SC-007–SC-010 | T070–T109, T131 | Stale Workspace isolation, degraded watcher, explicit 60-second collapsed-periodic idle check, bounded overflow queue |
| SC-011–SC-012 | T045, T119–T121, T127–T134 | Internal New/Rename/Delete watcher-echo idempotence and all repository quality gates |
| US1–US6 | T031–T122 | Story-specific task phases; see User Story Traceability below |

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** establishes the code-aware baseline.
- **Phase 2** is blocking: object identity, mixed-scope watcher correctness and pure reconciliation semantics must exist before a recursive Workspace watcher is wired into App.
- **US1 / Phase 3** is the MVP automatic Create/Delete synchronization slice.
- **US2 / Phase 4** depends on Phase 2 identity support and the Phase 3 canonical reconciliation path.
- **US3 / Phase 5** depends on the same canonical reconciliation path and adds noisy/lost-event recovery.
- **US4 / Phase 6** depends on US1+US3 scheduling behavior and tightens queue/periodic performance bounds.
- **US5 / Phase 7** can be developed after the Workspace coordinator exists, but must be complete before release because stale lifecycle work is a correctness issue.
- **US6 / Phase 8** uses the settled reconciliation/identity model to preserve interaction state and harden internal mutation races.
- **Phase 9** is the final analyze/release gate and depends on all intended story phases.

### Critical Implementation Order

```text
native filesystem-object identity
        +
mixed recursive/non-recursive watcher coverage
        ↓
pure identity-aware Explorer diff
        ↓
single Explorer reconciliation path
        ↓
Workspace watcher consumer (US1)
        ↓
confirmed relocation + 005 revalidation (US2)
        ↓
overflow/periodic/performance/lifecycle hardening
```

**Do not reorder the first four blocks**: starting the recursive root watch before mixed-scope watcher support can silently break 005/006 coverage, and implementing relocation before object identity would tempt the implementation to guess from watcher rename hints.

### Parallel Opportunities

- Rust object-identity tests/implementation and frontend pure reconciliation tests can proceed in parallel early in Phase 2, but their DTO integration must meet before Workspace listings are consumed.
- Pure batcher tests (`workspaceWatchBatcher`) can proceed beside Explorer reconciliation tests once Phase 2 contracts are fixed.
- US5 lifecycle tests can be authored while US3/US4 scheduling is implemented because the coordinator ports/scheduler are already defined, but lifecycle implementation should merge against the final queue semantics.
- Manual performance validation is intentionally last; it should validate the finished bounded scheduler rather than drive ad-hoc architectural changes.

## User Story Traceability

- **US1**: T031–T047 — Automatic External Create/Delete Synchronization (Priority: P1) 🎯 MVP
- **US2**: T048–T069 — Confirmed External Rename/Move Continuity (Priority: P1)
- **US3**: T070–T083 — Event Loss, Reordering & Final Convergence (Priority: P1)
- **US4**: T084–T096 — Large Workspace / Event-Storm Performance Bounds (Priority: P1)
- **US5**: T097–T109 — Workspace/Watcher Lifecycle, Degraded Mode & Root Recovery (Priority: P2)
- **US6**: T110–T122 — Explorer Interaction State, Symlinks & Mutation Races (Priority: P2)

## Implementation Strategy

### MVP First

1. Complete Phase 1 + Phase 2.
2. Complete US1 (automatic Create/Delete convergence).
3. Validate that root/loaded directory changes update automatically with no recursive scans.
4. Only then add relocation continuity and recovery/performance behavior.

### Safety Gates Before Declaring 006 Complete

- No raw watcher callback may directly mutate Explorer or DocumentSession.
- No rename/move continuity may be inferred without non-null filesystem-object proof.
- No 006 code may replace `comparisonKey` with native object id for canonical path ownership.
- No watcher/overflow/periodic path may recurse through the Workspace.
- External document relocation must return through 005 validation before external content state is considered resolved.
- A stale WorkContext/read/watch generation must be unable to commit even if its I/O completes.

## Notes

- `[P]` means file-level independence, not permission to violate a phase dependency.
- Keep thresholds/periodic interval centralized and injectable; do not spread magic timing constants across components.
- Prefer deterministic synthetic watcher/read tests. One or two bounded live watcher tests are enough to prove native integration.
- Do not “improve” 006 by adding filtering, indexing, Git integration, root-follow, recursive Expand All or a new notification system. Those are explicitly deferred.
- Commit after coherent task groups so later code review can distinguish identity/watcher foundation from Explorer/document behavior.

---

## Phase 10: Convergence

**Purpose**: Close the remaining gap between the frozen 006 intent and the current implementation, established by a converge assessment on the `feature-core` working tree. At assessment time `npm run typecheck`, `npm run test` (23 files / 711 tests), `npm run build` and `cargo test` (137 tests) were all verified green, so these tasks are behavioral/evidence gaps rather than gate failures. No constitution MUST principle is violated; identity is still supplemental to canonical path ownership and 006 never writes document text.

- [X] T135 Schedule background reconciliation only for a directory that is represented AND already read, per FR-023/US1-AC3/FR-029 (contradicts). `WorkspaceWatchCoordinator.hintTargets`/`handleBatch` (`src/app/workspace/workspaceWatchCoordinator.ts:627,633,702,713`) accept any node `findDirectoryNode` returns, including a visible row whose `loadState` is `not-loaded` (`src/app/explorer/explorerModel.ts:169-194`), and `reconcileDirectory` reads any represented node (`src/app/explorer/explorerController.ts:442-456`), so a hint for a direct child of a never-opened directory (for example a collapsed `node_modules` row during an install storm) loads that directory solely because of watcher events. Expose the existing loaded-vs-represented distinction (`src/app/explorer/explorerController.ts:251-271`) through `WorkspaceExplorerPort` as a represented-and-loaded/error-read predicate, use it for both the changed-parent and rename-target-parent candidates, keep the loaded-but-collapsed hint case (FR-075) and the post-subscription root reconcile working, remove the now-obsolete comment that justifies the weaker predicate, and add a coordinator regression test where a represented-but-never-read directory receives direct-child hints and produces zero reconciliation calls.
- [X] T136 Make an in-flight Workspace watch handshake and a pending batch belong to one WorkContext generation, per FR-100/FR-005/US5-AC1/SC-007 (partial). `ensureSubscription` installs the handle after `await watcher.subscribe(context.rootPath, "recursive")` while checking only the watch-lifecycle `generation`/`disposed` (`src/app/workspace/workspaceWatchCoordinator.ts:471-486`), and `retireContext` (`:428-440`) neither invalidates that attempt nor clears the shared `subscribing` latch, so an attempt started for Workspace A can be installed after B replaced it while B's own attempt is refused (`:465-467`) and B then reports a live subscription forever (`:462-463`) with A's events passing the subscriptionId filter (`:514`) and being rebased under B's logical root (`:722-730`). Additionally, an open batcher window created in `start()` (`:250-253`) survives `retireContext`, which clears only `pending` (`:430`), and is flushed with the current generation (`:561-563`), so hints collected under A can be applied to B. Tag each in-flight attempt and each batch with the requesting WorkContext id/generation (or invalidate/rotate both in `commitContext`/`retireContext`), stop a resolved handle that no longer matches the current context, restore subscription establishment for the replacement context, reset `subscribing` per context, and add race tests that hold A's `subscribe` open and open a coalescing window under A, then commit B and assert zero B reconciles, zero relocation requests and a live B-subscription handshake.
- [X] T137 Force the post-relocation 005 revalidation whenever the bound path changed, not only when the comparison key changed, per FR-061/US2-AC8 (partial, data safety). `DocumentManager.applyPath` emits the `rebound` carrying `cause: "external-relocation"` only when `previousIdentity.comparisonKey !== identity.comparisonKey` (`src/app/document/documentManager.ts:2535`), while `adoptOneRelocation` has already stored the destination's current `diskRevision` as the binding identity (`:2333-2399`); `OpenedDocumentWatchCoordinator.registerInterest` therefore never sees the relocation cause for a Windows case-only or equivalent-spelling relocation such as `foo.ts` -> `Foo.ts` (`src/app/document/openedDocumentWatchCoordinator.ts:574-624`), and `DiskValidator` answers `unchanged` for every later non-forced trigger including the mandatory pre-save check (`src/app/document/diskValidation.ts:278-291`, `src/app/document/documentManager.ts:1720-1727`), silently clearing a content change that happened during the move. Emit the relocation cause on any path change, handle that cause before the same-comparison-key early return so the forced snapshot read still runs, and add a case-only relocation test in `src/app/document/openedDocumentWatchCoordinator.test.ts`/`documentManager.test.ts` where the content changed during the move (clean reloads; a dirty divergent target becomes `modified`; the buffer is never replaced by 006).
- [X] T138 Cancel an active inline rename when a confirmed relocation moves its own target, per FR-087/US6-AC5 (contradicts). `applyInteractionState` rebases the inline edit for every relocation (`src/app/explorer/explorerController.ts:1004-1011`, with `rebaseInlineEdit` at `:1140-1156` whose comment claims FR-087 while doing the opposite) and then cancels only when the post-rebase path is absent from the Tree (`:1025-1035`), so an externally renamed inline-rename target keeps a live editor with a stale `originalName`. Clear `state.inlineEdit` when a relocation's `oldPath` is within the edit's `sourcePath` before applying authoritative structural state, keep selection rebasing and the invalid-parent-context cancellation, keep unrelated edits untouched (FR-088), and extend `src/app/explorer/explorerController.test.ts` with an inline-rename-of-relocated-target case alongside the existing same-path replacement case.
- [X] T139 Notify the UI after a successful external adoption, per FR-057/US2-AC2 (partial). `adoptExternalRelocation`/`adoptOneRelocation` commit path, `displayName` and binding generation (`src/app/document/documentManager.ts:2395-2401`) with no `emitSnapshot()` anywhere in that path (contrast the internal rename emit at `:2224`), and `setExternalState` emits only when the external state actually changes (`:2591-2600`), so a relocated Tab keeps the previous file name until an unrelated emit such as an edit or Tab switch. Emit the document snapshot once the adoption — and its forced 005 revalidation, when one is scheduled — settles, and pin it in `src/app/document/documentManager.test.ts` with a `subscribe()`-driven listener assertion instead of a direct `getSnapshot()` read.
- [X] T140 Add the deterministic scheduler proof that a user-requested read outranks background recovery work, per SC-003/T084 (partial). SC-003 requires tests proving a user selection/expansion read can run ahead of the remaining recovery backlog, and no such test exists: `enqueue` is only ever called with `"watcher"`/`"recovery"` (`src/app/workspace/workspaceWatchCoordinator.ts:361,649,768`) and `"user"` appears only in comments in `src/app/workspace/workspaceWatchCoordinator.test.ts`. Add a test that holds recovery reconciles open, queues a multi-directory recovery backlog, performs a user expansion through `ExplorerController` (`reconcileDirectory(..., "user")`), and asserts the user read settles before the remaining backlog drains, including that the bounded queue honours `SOURCE_PRIORITY.user` over `recovery`/`periodic`.
- [X] T141 Perform and record the manual disposable-project acceptance matrix, per plan.md "Integration/manual validation" and T131 (partial). `tasks.md` records T131 as NOT PERFORMED: run the eight plan scenarios (large collapsed `node_modules` with a real package-manager storm; `git checkout`/`reset --hard` structural churn; file and directory relocation with clean/dirty Tabs; case-only Windows rename; whole-subtree delete; Workspace root move and restore; junction/symlink branch including an outside-root target; Workspace switch/close during active events) and record the observed Explorer/disk agreement in the Execution Evidence section. If no interactive desktop session is available, record the outstanding matrix explicitly there as a release gate together with which scenarios the deterministic suites cover instead, so 006 is not reported complete on unverified real-world behavior. *(Completed the first way: the matrix was executed manually by the reporter and is recorded as PASS in the Execution Evidence section; the equivalent deterministic coverage per scenario is listed there as the regression safety net.)*
- [X] T142 Pin the real collapsed-directory exclusion in the periodic proof, per SC-009/FR-074/T085 (partial). The SC-009 test (`src/app/workspace/workspaceWatchCoordinator.test.ts:1306-1325`) takes its expanded set from `FakeExplorer.represent`, which injects the expanded paths directly, so the real `ExplorerController.listExpandedDirectoryPaths()` exclusion is never exercised, and the only real-controller assertion of that API (`src/app/explorer/explorerController.test.ts:869-887`) has no collapsed node and does not meet T085's "hundreds of loaded directories, most collapsed" fixture. Add a controller fixture with hundreds of loaded directories, most collapsed, assert the accessor returns root + currently expanded paths only, and feed that real list into a coordinator periodic pass asserting zero reads of loaded-but-collapsed directories.
- [X] T143 Exercise periodic reconciliation over the 100,000-descendant fixture, per SC-002 (partial). The scale fixture (`src/app/workspace/workspaceWatchCoordinator.test.ts:1203-1231`) covers watcher startup and one 10,000-hint burst but never fires a periodic pass, although SC-002 names startup, ordinary event handling and periodic reconciliation. Fire one or more periodic passes over the same fixture and assert no reconciliation path targets the unopened `node_modules` subtree and no never-loaded descendant is read.
- [X] T144 Locate the pre-mutation source entry by leaf name before comparing identity, per FR-066 (partial). The one-level parent re-read before Rename/Delete is correct and no-follow, but it matches the fresh listing with exact `entry.path === sourcePath` (`src/app/explorer/explorerActions.ts:986-1000`), so when only the on-disk leaf casing changed since the node was built (an unreconciled case-only external rename, or a degraded watcher) a legitimate Rename/Delete is refused with the source-changed failure even though the entry's non-null `objectIdentity` still equals the captured token. Match the direct child by leaf name under the re-read parent (case-insensitively on Windows) and then require kind plus non-null identity equality; keep the conservative refusal for a genuinely missing, replaced, wrong-kind or identity-less entry, and add a "same object, changed leaf casing" Rename test.

---

## Phase 11: Convergence

**Purpose**: Close residual identity, concurrency, visibility, canonical-path and release-evidence gaps found by the fallback convergence audit after Phase 10. At assessment time all existing T001–T144 tasks were checked and `npm run typecheck`, `npm run test` (23 files / 728 tests), `npm run build` and `cargo test` (137 tests) were green; these are uncovered behavioral and evidence gaps, not failures of the existing gate suite.

- [X] T145 Treat a same-path listing with unavailable identity as remove+create, per FR-034/FR-042 (contradicts, data safety). `identityContinuity` currently returns true whenever either the represented or listed `objectIdentity` is `null` (`src/app/explorer/explorerReconciliation.ts:147-163`), so a replacement at the same logical path can inherit the old node and its cached/interaction state without affirmative filesystem-object proof. Require matching non-null identities for continuity, preserve conservative same-object relocation only when identity proves it, and add reconciliation/controller regressions showing that a same-path null-identity replacement receives a fresh node and inherits no stale children, selection or inline-edit state.
- [X] T146 Serialize native watcher backend-coverage transitions without holding the core state lock across backend I/O, per FR-003/FR-005/FR-009 and the mixed-scope invariant (contradicts, concurrency/data safety). `begin_subscribe` publishes the logical subscription and desired coverage before the backend watch/reconfigure finishes (`src-tauri/src/filesystem_watcher.rs:434-553,1113-1142`), so overlapping same-scope start/start can let the second caller return against coverage that the first later fails to establish; overlapping stop/start can likewise leave recursive demand served by non-recursive coverage. Add a dedicated per-manager or per-scope transition serialization/state machine, roll back or retry every dependent logical subscription atomically on failure, retain the no-core-lock-during-backend-call rule, and add deterministic held/failing-backend tests for start/start and stop/start overlap.
- [X] T147 Prevent confirmed external relocation from claiming a destination with an in-flight Open, per FR-062/FR-063/FR-065 and T057/T120 (contradicts, concurrency/data safety). `describeDestinationConflict` checks committed ownership, path claims and mutations but not `pendingOpens` (`src/app/document/documentManager.ts:2418-2442`), while `registerOpenedSession` later installs a new session and overwrites `openPathIndex` (`:1069-1114`). Make relocation wait for or reject a destination pending Open under the existing generation/claim discipline, preserve exactly one live session and canonical owner regardless of completion order, and add controlled Open-vs-relocation tests for both orderings and failures.
- [X] T148 Stop periodic/recovery enumeration below a collapsed ancestor while retaining descendant expansion state for later restoration, per FR-070/FR-074/US4-AC3 (contradicts). `ExplorerController.listExpandedDirectoryPaths()` recurses through every cached child even when its ancestor is collapsed (`src/app/explorer/explorerController.ts:293-310`), so a previously expanded hidden descendant can still be read by periodic work. Prune traversal at a collapsed node without clearing stored descendant flags, and add a nested real-controller/coordinator regression proving zero reads under the collapsed ancestor followed by correct restoration after re-expansion.
- [X] T149 Reschedule pending work when a stale Workspace drain exits across dispose/start, per FR-100/FR-101/US5-AC1 (partial, concurrency). `dispose()` advances generation and clears queues but leaves `draining` true (`src/app/workspace/workspaceWatchCoordinator.ts:305-335`); an immediate `start()` can enqueue the new root while `scheduleDrain` returns, after which the old drain exits on generation mismatch without scheduling the new generation (`:861-950`). On every stale-drain exit, safely hand off to any current-generation pending work without allowing the stale task to commit, and add a start → held drain → dispose → start regression that proves the replacement root reconciles and no old-root work commits.
- [X] T150 Make pre-mutation leaf lookup platform-correct and ambiguity-safe, per Constitution I and FR-066 (contradicts, data safety). `sameLeafName` lowercases unconditionally and the lookup accepts the first matching child (`src/app/explorer/explorerActions.ts:187-189,1014-1033`), so a case-sensitive filesystem containing two case-distinct hardlinks with the same object identity can select and mutate the wrong path. Prefer an exact leaf match on every platform; only where the platform contract is case-insensitive accept a unique folded-name candidate with matching non-null identity and kind; reject ambiguity, and cover two case-distinct same-identity entries plus Windows case-only continuity.
- [X] T151 Derive external relocation candidates and relative targets from the confirmed canonical source prefix, per FR-045/FR-056/FR-058 (partial). `DocumentManager` currently uses logical string containment for candidate selection and relative-path calculation (`src/app/document/documentManager.ts:2269-2278,2317`), so an open session using equivalent casing or symlink spelling may not follow a confirmed file/directory relocation. Carry or safely resolve the canonical old-source prefix independently of the object-identity token, keep canonical path ownership in `comparisonKey`, reject escape/ambiguous relations, and add file and nested-directory tests for equivalent case and symlink spellings.
- [X] T152 Pin the complete 60-second collapsed-subtree success window required by SC-009 (partial evidence). The periodic regression currently fires five 10-second ticks (`src/app/workspace/workspaceWatchCoordinator.test.ts:1468-1487`), proving only 50 seconds. Advance the injected clock through six full intervals (or an explicit 60,000 ms), assert every eligible expanded directory remains covered, and assert the collapsed subtree receives zero reads throughout the entire window.
- [X] T153 Restore auditable release evidence for T131/T141 and the plan's eight-scenario acceptance matrix (missing evidence). Both checked tasks state that observed results are recorded in an `Execution Evidence` section, but this file ends without that section. Append the actual dated scenario-by-scenario observations and the four command results, including environment and any limitations; if the manual desktop matrix cannot be reproduced, mark those scenarios and the 006 release gate explicitly unverified rather than retaining an unsupported PASS claim.

---

## Phase 12: Convergence

**Purpose**: Finish the platform-correct path relation work that Phase 11 described but implemented with unconditional case folding. The Phase 11 audit otherwise converged: T145–T149 and T152–T153 are satisfied, and all four repository gates remain green (23 frontend test files / 739 tests; 139 Rust tests — the counts at the time this phase was appended).

- [X] T154 Make pre-mutation leaf recovery use an explicit backend/platform comparison contract, per Constitution I, FR-066 and T150 (CRITICAL, contradicts). `findSourceEntry` correctly prefers an exact leaf and refuses multiple folded candidates, but `sameLeafName` still calls `toLowerCase()` unconditionally (`src/app/explorer/explorerActions.ts:187-189,207-216`). On a case-sensitive filesystem, if the captured spelling disappeared and exactly one case-distinct hardlink with the same non-null identity remains, that unique folded fallback authorizes Rename/Delete against a different directory entry. Reuse or expose the Rust path-comparison semantics rather than inferring the platform in TypeScript; permit the folded fallback only when the resolved parent contract is case-insensitive, keep exact matching on every platform, and add a case-sensitive regression where the sole differently-cased same-identity hardlink is refused alongside the existing Windows case-only and ambiguous-collision cases.
- [X] T155 Derive external-relocation containment and suffixes from the confirmed canonical old-source relation, per FR-045/FR-056/FR-058 and T151 (HIGH, partial). `relativeWithinFolded` and `canonicalSuffixMatches` unconditionally lowercase every component (`src/app/document/documentManager.ts:328-382`), and the latter proves only that the session canonical path ends with the logical suffix—not that it is within the canonical source prefix. A case-sensitive path that differs only by case, or an unrelated hardlink/symlink target in another directory with the same tail and object identity, can therefore be adopted as if it moved. Carry the canonical old-source identity in the relocation request or resolve the relation through the existing platform-aware Rust primitive, derive the suffix only from canonical containment, preserve Windows case-only continuity, reject escape/disjoint/ambiguous relations, and add case-sensitive hardlink plus same-tail symlink regressions as well as the positive equivalent-spelling cases.

**Result**: both tasks implemented and mutation-checked. The case-comparison contract now comes from the backend (`WorkspaceDirectoryResult.case_sensitive`), and external-relocation containment is decided on canonical comparison keys only. At that point the frontend suite was 23 files / 743 tests and Rust 140, with all four gates green (Phase 13 then raised those to 744 / 145). Per-task evidence is in "Phase 12 convergence (T154–T155)" above; the residual limitation (a relocation whose old path's parent is gone is conservatively not adopted) is recorded there.

---

## Phase 13: Convergence

**Purpose**: Make the backend path-comparison contract truthful for Windows directories that opt into per-directory case sensitivity; Phase 12 otherwise closes the two reported folded-name and relocation-source gaps.

- [X] T156 Replace the platform-wide/collision-inference case rule with the filesystem directory's actual comparison semantics, per Constitution I, FR-038, FR-066 and T154–T155 (CRITICAL, contradicts). `directory_is_case_sensitive` currently returns the platform default unless the current listing already contains a case-colliding pair (`src-tauri/src/workspace_fs.rs:204-224`), so a Windows directory with per-directory case sensitivity enabled but no such pair is falsely reported as insensitive; `findSourceEntry` can then authorize Rename/Delete against the sole differently-cased same-identity hardlink. The same platform-wide `comparison_key` lowercasing (`src-tauri/src/file_identity.rs:298-324`) makes T155's otherwise-correct canonical containment collapse distinct paths under that directory. Query the resolved directory's real case-sensitivity metadata on Windows (and the equivalent authoritative rule on supported platforms), treat an unavailable/failed query conservatively as case-sensitive for mutation and relocation continuity, and use one shared component-aware contract for `WorkspaceDirectoryResult.caseSensitive`, resolved/missing-path comparison keys, relation containment and relocation source keys. Add native coverage for a case-sensitive Windows-directory model with no pre-existing case-colliding names, synchronized IPC tests, and frontend regressions proving exact names still work while a unique differently-cased same-identity entry and a case-distinct relocation source are both refused; retain positive case-only behavior in a proven case-insensitive directory.

**Result**: implemented and mutation-checked. The case rule is now a property of a *directory*: `file_identity::directory_case_sensitive` asks the Windows `FileCaseSensitiveInfo` flag through a handle opened for attribute queries only, falls back to the authoritative platform rule elsewhere, and resolves every unavailable answer conservatively to "case-sensitive". `comparison_key`, `relative_within` and `WorkspaceDirectoryResult.caseSensitive` all go through that one contract component by component, so a case-sensitive directory keeps its names distinct in path ownership, in containment and in the pre-mutation source check. The frontend suite is 23 files / 744 tests and Rust is 145, with all four gates green. Per-task evidence is in "Phase 13 convergence (T156)" above, including the accepted consequence of the conservative fallback.
