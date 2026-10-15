# Implementation Plan: Workspace Filesystem Synchronization

**Implementation Branch**: `feature-core` (intentionally retained; Spec Kit feature pointer: `specs/006-workspace-filesystem-sync`) | **Date**: 2026-09-19 | **Spec**: `specs/006-workspace-filesystem-sync/spec.md`

**Input**: Feature specification from `/specs/006-workspace-filesystem-sync/spec.md`

## Summary

006 turns the 003 Explorer from manual-refresh-only into an automatically converging Workspace view without changing the lazy single-root model. It reuses the generic `notify`-backed filesystem watcher introduced by 005, adds a **separate Workspace watcher consumer**, coalesces raw hints into affected represented directories, and drives all structural updates through generation-safe one-level filesystem reconciliation. Watcher events never mutate Tree state directly and never become document-content truth.

The implementation also activates one deferred capability that current path identity cannot yet provide: reliable external rename/move continuity. Add a filesystem-object identity token that is stable across a same-object rename/move where the platform/filesystem supports it. Use that token only as continuity evidence; canonical path `comparisonKey` remains the ownership/reservation key. Confirmed relocation can preserve Explorer node/subtree state and request DocumentManager path rebinding, while unconfirmed relocation remains remove/create. After any document rebind, 005 still performs authoritative content validation at the new path.

A second code-aware migration is mandatory in the 005 watcher backend: current backend-watch sharing is keyed only by canonical directory and assumes 005/006 never mix scopes. 006 creates exactly that case when a recursive Workspace-root subscription coexists with a non-recursive opened-document subscription whose parent is the Workspace root. The watcher core must support mixed scope without allowing a non-recursive first subscriber to silently downgrade recursive Workspace coverage.

## Technical Context

**Language/Version**: Existing Sorakada TypeScript/React frontend and Rust/Tauri backend; retain repository-pinned versions (TypeScript `~6.0.3`, React 19, Tauri 2, current Rust toolchain/lockfile).

**Primary Dependencies**: Existing React, CodeMirror 6, Tauri and the already-installed Rust `notify` watcher dependency from 005. Do not add another watcher framework. Reuse existing `trash`/filesystem dependencies only where already required by 003.

**Storage**: Local filesystem only. No persistent database, event log, index or Workspace cache is added.

**Testing**: Vitest for deterministic frontend coordinator/model/orchestration tests; Rust `cargo test` for native watcher routing, filesystem-object identity and IPC serialization. Keep OS-timing-dependent live watcher tests narrowly scoped; most behavior must use injected watcher events/schedulers/readers.

**Target Platform**: Windows-first Tauri desktop application. Native file-object identity should be implemented behind a platform-neutral opaque contract and degrade to `null`/unavailable where a stable token cannot be obtained.

**Project Type**: Desktop application (React/TypeScript + Tauri/Rust native filesystem layer).

**Performance Goals**:
- Starting Workspace synchronization performs zero recursive descendant enumeration.
- Raw event count does not map one-for-one to directory reads; burst/event-storm work is bounded by represented directory state.
- Never-loaded directories remain unread solely because events occurred under them.
- Loaded-but-collapsed directories perform no periodic reads unless a specific watcher hint or explicit Manual Refresh targets them.
- A collapsed `node_modules` subtree with tens/hundreds of thousands of descendants can receive an event storm without a recursive read or unbounded reconciliation queue.
- User-triggered expansion remains responsive while background recovery is pending.

**Constraints**:
- Preserve 005 opened-document external-change semantics and keep `OpenedDocumentWatchCoordinator` separate from Workspace synchronization.
- Preserve 003 single-root WorkContext, lazy Tree, command and Manual Refresh behavior except where `spec.md` explicitly supersedes external-change/re-expansion rules.
- Watcher callbacks never directly mutate Explorer or DocumentSession state.
- Reconciliation reads exactly one directory level; no watcher event, overflow recovery or periodic pass may recursively walk the Workspace.
- CodeMirror continues to own live text; 006 never adopts/reloads document content directly.
- Path/session ownership continues to use canonical `comparisonKey`; native filesystem-object identity is supplemental continuity evidence only.
- Internal Rename/Delete remains disk-first and must not act on an externally replaced object after the user selected/confirmed it.
- No correctness rule may depend on event count, exact event order, fixed “self event” suppression or raw path-string equality.
- Do not move/rename existing core modules merely to match suggested layout.

**Scale/Scope**: One active Workspace root; realistic developer projects including `node_modules`, build output and Git churn; a few to hundreds of represented/loaded directories, potentially hundreds of thousands of unrepresented descendants; normal editor counts of open documents.

## Constitution Check

### Pre-design check

- **I. User Data Is Inviolable — PASS**: 006 never writes document content because of a watcher event. External relocation preserves in-memory state, keeps path ownership unique, and forces 005 validation after rebinding. Internal destructive operations verify the selected filesystem object before acting so an external replacement cannot redirect a Rename/Delete onto the wrong object.
- **II. State Has One Owner — PASS**: `WorkContextManager` remains Workspace identity owner; `ExplorerController` remains Tree/selection/expansion owner; DocumentManager remains document binding/ownership owner; CodeMirror remains text owner; Rust remains filesystem/identity/watcher owner. New Workspace coordinator schedules work but owns none of those facts.
- **III. Contracts Are Verified From Both Sides — PASS BY REQUIRED TASKS**: any filesystem-object identity or watcher DTO extension receives Rust serialization/native tests and matching TypeScript contract tests. Mixed-scope watcher routing, stale generation, external relocation, event-storm and failure paths receive deterministic coverage. All four repository gates remain mandatory.
- **IV. Commands Have One Execution Path — PASS**: no duplicate user command is introduced. Manual Refresh keeps its canonical command; automatic watcher/periodic synchronization calls the same Explorer reconciliation primitive below the command layer. Existing Rename/Delete commands retain their one path and gain object-identity validation inside that path.
- **V. Scope and Complexity Must Be Earned — PASS**: the Workspace coordinator, bounded batcher/reconciliation scheduling and filesystem-object identity are directly required by the frozen 006 behavior. No index, event database, plugin framework, second watcher library, recursive crawler or generic transaction system is introduced.

### Post-design check

The design below keeps each new abstraction narrow: native identity is an opaque filesystem fact; the watcher backend remains domain-neutral; the Workspace watch coordinator consumes hints only; Explorer owns reconciliation/application; DocumentManager owns binding adoption. The final implementation review MUST reject any direct watcher-to-Tree mutation, any document relocation that bypasses DocumentManager, any full-Workspace recovery walk, or any change that makes native object id the canonical path-ownership key.

## Existing Architecture to Preserve

Repository review of `feature-core` established these current modules and contracts:

```text
src/app/App.tsx
src/app/document/documentManager.ts
src/app/document/documentSession.ts
src/app/document/diskValidation.ts
src/app/document/openedDocumentWatchCoordinator.ts
src/app/document/internalFsOperationGuard.ts
src/app/workspace/workContext.ts
src/app/workspace/workContextManager.ts
src/app/explorer/explorerModel.ts
src/app/explorer/explorerController.ts
src/app/explorer/explorerActions.ts
src/services/fileService.ts
src/services/filesystemWatcher.ts
src/services/watchEventNormalizer.ts
src/services/workspaceFileService.ts
src-tauri/src/file_identity.rs
src-tauri/src/filesystem_watcher.rs
src-tauri/src/watch_event.rs
src-tauri/src/commands/watcher.rs
src-tauri/src/commands/workspace.rs
src-tauri/src/lib.rs
```

Important confirmed current behavior:

- `filesystemWatcher.ts` already exposes `nonRecursive | recursive` scope and preserves `renameTarget` for 006.
- `OpenedDocumentWatchCoordinator` is explicitly 005-only and must stay that way.
- `watchEventNormalizer.ts` is keyed around opened-document interests/comparison keys; do not distort it into a Workspace Tree normalizer. 006 gets a Workspace-specific batcher/coordinator beside it.
- `ExplorerController` already owns lazy cache, selection, inline edit, root-unavailable state and per-node stale read tokens.
- Manual `refresh()` rereads all loaded directories, including loaded-but-collapsed ones; this broader explicit behavior remains intact.
- Current `ResolvedPathIdentity` contains canonical path/comparison key/disk revision but **no stable native object id**.
- Current Rust `WatcherCore` shares backend watches by directory key only; its comment explicitly assumes “005 and 006 never mix scopes on one directory.” That assumption must be removed before 006 starts a recursive root watch.

## Path Alias Contract for Implementation Tasks

Resolve these aliases against the actual repository before editing; do not create duplicate replacements if paths moved:

```text
$APP                         = src/app/App.tsx
$DOC_MANAGER                 = src/app/document/documentManager.ts
$DOC_SESSION                 = src/app/document/documentSession.ts
$DISK_VALIDATION             = src/app/document/diskValidation.ts
$OPEN_DOC_WATCH              = src/app/document/openedDocumentWatchCoordinator.ts
$FS_GUARD                    = src/app/document/internalFsOperationGuard.ts
$WORK_CONTEXT                = src/app/workspace/workContext.ts
$WORK_CONTEXT_MANAGER        = src/app/workspace/workContextManager.ts
$EXPLORER_MODEL              = src/app/explorer/explorerModel.ts
$EXPLORER_CONTROLLER         = src/app/explorer/explorerController.ts
$EXPLORER_ACTIONS            = src/app/explorer/explorerActions.ts
$FILE_SERVICE_TS             = src/services/fileService.ts
$WATCHER_SERVICE_TS          = src/services/filesystemWatcher.ts
$DOC_WATCH_NORMALIZER        = src/services/watchEventNormalizer.ts
$WORKSPACE_FILE_SERVICE_TS   = src/services/workspaceFileService.ts
$FILE_IDENTITY_RS            = src-tauri/src/file_identity.rs
$WATCHER_RS                  = src-tauri/src/filesystem_watcher.rs
$WATCH_EVENT_RS              = src-tauri/src/watch_event.rs
$WATCHER_COMMAND_RS          = src-tauri/src/commands/watcher.rs
$WORKSPACE_COMMAND_RS        = src-tauri/src/commands/workspace.rs
$TAURI_LIB_RS                = src-tauri/src/lib.rs
```

Suggested new files:

```text
src/app/workspace/workspaceWatchBatcher.ts
src/app/workspace/workspaceWatchBatcher.test.ts
src/app/workspace/workspaceWatchCoordinator.ts
src/app/workspace/workspaceWatchCoordinator.test.ts
src/app/explorer/explorerReconciliation.ts
src/app/explorer/explorerReconciliation.test.ts
```

Exact splitting may be adjusted only if it preserves the ownership rules below. Do not add empty services or a generic event bus.

## Project Structure

### Documentation (this feature)

```text
specs/006-workspace-filesystem-sync/
├── spec.md
├── plan.md
├── tasks.md
└── consistency-check.md
```

### Source Code (target structure; preserve existing equivalents)

```text
src/
├── app/
│   ├── App.tsx
│   ├── document/
│   │   ├── documentManager.ts
│   │   ├── documentSession.ts
│   │   ├── diskValidation.ts
│   │   ├── openedDocumentWatchCoordinator.ts
│   │   └── internalFsOperationGuard.ts
│   ├── workspace/
│   │   ├── workContext.ts
│   │   ├── workContextManager.ts
│   │   ├── workspaceWatchBatcher.ts          # NEW: Workspace event-window reduction only
│   │   └── workspaceWatchCoordinator.ts      # NEW: lifecycle, scheduling, periodic/storm recovery
│   └── explorer/
│       ├── explorerModel.ts
│       ├── explorerController.ts
│       ├── explorerActions.ts
│       └── explorerReconciliation.ts         # NEW: pure snapshot diff/identity relocation matching
├── services/
│   ├── fileService.ts
│   ├── filesystemWatcher.ts
│   ├── watchEventNormalizer.ts              # keep 005 document-specific behavior
│   └── workspaceFileService.ts
└── [existing UI/styles unchanged; reuse the existing root-unavailable/error projection only]

src-tauri/src/
├── file_identity.rs                         # extend with opaque filesystem-object identity
├── filesystem_watcher.rs                    # mixed-scope backend-watch coverage
├── watch_event.rs
├── commands/
│   ├── watcher.rs
│   └── workspace.rs                         # directory entry identity on one-level reads
└── lib.rs
```

**Structure Decision**: Extend the existing watcher and Explorer rather than layering a new filesystem model over them. `WorkspaceWatchCoordinator` is a consumer/orchestrator, not a Tree owner. `ExplorerController` remains the only owner applying structural state; `explorerReconciliation.ts` contains pure diff/matching logic so rename/move identity behavior is deterministic and testable. Document binding changes remain exclusively in DocumentManager.

## Design

### 1. Preserve two independent watcher consumers

The watcher event channel remains generic:

```text
Rust notify backend
        ↓
normalized WatchEventPayload
        ├── OpenedDocumentWatchCoordinator (005)
        │      ↓
        │   document validation/content state
        │
        └── WorkspaceWatchCoordinator (006)
               ↓
           Explorer reconciliation requests
```

Do **not** import Explorer/WorkContext code into `OpenedDocumentWatchCoordinator`. Do **not** make the generic `filesystemWatcher.ts` know about documents or Workspace.

Both consumers may receive the same raw notification and independently derive their own correctness:

- 005 validates a currently bound open document.
- 006 decides which represented directory may need a one-level reread.

This duplication of *hints* is intentional; state ownership remains separate.

### 2. Fix mixed non-recursive/recursive backend-watch coverage before Workspace subscription

Current `WatcherCore` shares by `directory_key` and lets the first subscriber choose the backend mode. That is invalid once this legal situation exists:

```text
Workspace root = D:\project
006 -> Recursive(D:\project)
005 open document = D:\project\README.md
005 -> NonRecursive(parent D:\project)
```

Required backend invariant:

> Effective OS coverage for a watched directory is the strongest scope required by any live subscription, while routing to each subscription still follows that subscription's own scope.

Recommended minimal implementation:

- `WatchRecord` tracks non-recursive and recursive subscriber counts (or equivalent), plus current effective backend scope.
- Effective scope is `Recursive` whenever at least one recursive subscription exists; otherwise `NonRecursive`.
- Adding a recursive subscription to an existing non-recursive backend watch upgrades the backend coverage before the recursive subscription is reported live.
- Removing the last recursive subscription may downgrade back to non-recursive so a closed Workspace does not leave 005 paying recursive-event cost indefinitely.
- Any unwatch/re-watch transition that can create an event-loss window emits/causes invalidation so consumers reconcile instead of trusting continuity.
- If reconfiguration fails, rollback bookkeeping where possible and surface an ordinary watch error to the subscription that could not be established; existing subscriptions must remain safe or receive invalidation/degraded behavior.
- Subscription routing remains `SubscriptionRecord.matches`: recursive backend over-observation does not make a 005 file interest consume unrelated descendants.
- Preserve the existing `WatchInvalidated { scope, watchedPath, reason }` wire shape. Invalidation MUST be derived from live logical subscriptions, not merely the backend `WatchRecord` effective scope: emit/deduplicate invalidation per affected `(logical scope, watchedPath)`. For a backend-global loss notice with no paths, emit the affected logical scope/path pairs currently registered. This lets 005 and 006 independently decide whether an invalidation concerns them even when they share one promoted recursive backend watch.
- `OpenedDocumentWatchCoordinator` must ignore recursive-only invalidations that do not intersect its current non-recursive interests before feeding its document normalizer; `WorkspaceWatchCoordinator` accepts only the current recursive root/global-equivalent invalidation. A loss notice for one consumer must not force unrelated work in the other merely because both listen to the same event channel.
- Extend normalized `WatchEvent` change payloads with subscription-relative location data, e.g. `relativePath: string | null` and `renameTargetRelativePath: string | null`. Rust computes these with the existing platform-aware `file_identity::relative_within(watched_path, event_path)` for each logical subscription. Keep raw `path`/`renameTarget` for 005 validation and outside-move candidates, but 006 maps an in-root event back onto Explorer by joining `WorkContext.rootPath` with the relative path. This prevents canonical/`\\?\`/symlink-root spelling from becoming a second Tree identity system. A rename target outside the recursive root has `renameTargetRelativePath = null` while its raw target may still be retained as a document-only relocation candidate.

Do not key path ownership or subscriptions by raw string.

### 3. Add supplemental filesystem-object identity

Canonical path identity cannot prove a rename because the canonical path itself changes. Add an opaque serializable object identity:

```text
FilesystemObjectIdentity
```

Semantics:

- stable for the same file/directory across rename/move on the same supported filesystem;
- different for a delete/recreate replacement in normal supported cases;
- optional/unavailable when the platform/filesystem cannot supply a reliable value;
- never used as the `openPathIndex`/destination ownership key;
- never used to globally deduplicate symlink Tree nodes.

Implementation direction:

- Windows: derive an opaque token from stable native metadata such as volume identity + file index/file id exposed by the current Rust toolchain/platform APIs.
- Other supported platforms: use a native stable object identity such as device + inode where available, behind the same opaque DTO.
- Existing `ResolvedPathIdentity` gains `objectIdentity: string | null` for the **resolved target object** (following the final symlink in the same way current path identity does).
- `WorkspaceDirectoryEntry` gains `objectIdentity: string | null` for the **directory entry itself** (use link/reparse-point metadata for a symlink entry), so Tree snapshots can prove that logical entry was renamed without conflating it with the target object.
- These two tokens normally coincide for ordinary files/directories but are intentionally allowed to differ for symlinks; document relocation must compare the newly resolved target against the document binding, not blindly reuse the Tree entry token.
- Keep the token opaque in TypeScript. No frontend code parses its platform representation.
- Directory enumeration must not recursively inspect descendants and must not read file contents merely to obtain identity.
- Sorakada-originated New File/New Folder already inserts a node directly without rereading its parent. That fast path must copy `CreateWorkspaceEntryResult.identity.objectIdentity` into the inserted `WorkspaceDirectoryEntry`; a freshly created ordinary file/directory must not temporarily become an identity-less Tree node merely because no reconciliation has run yet.

Tests must prove same-object rename stability and delete/recreate distinction on the primary Windows path where practical; platforms without identity support must prove safe `null` fallback.

### 4. Workspace event batching is separate from 005 document hint normalization

`watchEventNormalizer.ts` is intentionally document-interest-specific. Add `workspaceWatchBatcher.ts` with an injected scheduler.

One non-restarting short window (initial implementation target: approximately the existing 005 100 ms scale) collects:

- raw event count;
- unique changed paths;
- paired rename source/target candidates when present;
- invalidation/overflow flag and reason(s).

The batcher does not mutate Tree state and does not prove rename. It only gives the coordinator enough information to derive affected represented parents.

When the batch exceeds a centralized storm threshold, it may stop retaining fine-grained path detail and emit `requiresRecovery = true`. The exact threshold is an implementation constant validated by tests/benchmarks, not a product contract.

### 5. WorkspaceWatchCoordinator lifecycle

`WorkspaceWatchCoordinator` subscribes to:

- `WorkContextManager` snapshots;
- generic filesystem watcher events;
- application focus signal if already available through App wiring.

For a committed context:

```text
context committed
→ subscribe(rootPath, recursive)
→ retain the returned Workspace subscription id/handle
→ capture context id + WorkContext generation + watch generation
→ start one periodic timer
```

Ordinary `Change` payloads are batched only when they belong to that current Workspace subscription. 005 document-subscription events on the shared event channel are ignored by the Workspace consumer. `Invalidated` payloads have no subscription id, so the backend emits them per affected logical scope/watched-path and each consumer filters before normalization: 006 accepts only the current recursive root (or its explicit global-equivalent invalidation), while 005 ignores recursive-only invalidations unrelated to its non-recursive interests.

After a recursive Workspace subscription becomes live, request one generation-safe root reconciliation if the Explorer already represents that context. If the Explorer context has not been installed yet, its normal initial root load is the later authoritative read. This closes the initial root-read -> watch-arming gap without recursively scanning anything.

On replacement/close:

```text
invalidate generation first
→ stop timer / stop scheduling
→ stop old recursive subscription (best effort)
→ drop pending batches/queue ownership
```

Do not block Workspace close on old I/O. Every callback checks current generation before scheduling/applying.

Watcher start failure:

```text
Workspace stays open/readable
→ coordinator = degraded (no active Workspace watch handle)
→ periodic reconciliation + Manual Refresh remain
→ later root success/focus/periodic pass may retry subscription
```

A normal watcher `Invalidated`/rescan notice means completeness was lost and triggers recovery reconciliation, but it does **not** by itself discard/rebuild an otherwise live subscription. Re-subscribe only when start/reconfiguration actually failed or the handle is known unusable.

No new global notification framework is required for degraded mode.

### 6. Map hints to represented directory work, not to recursive scans

For a normal path hint:

- first map the Workspace subscription's `relativePath` back under the current logical `WorkContext.rootPath`; do not use raw canonical/native watcher path spelling as an Explorer lookup key;
- mapped source path -> its direct parent is a reconciliation candidate;
- paired rename -> mapped source parent + mapped in-root target parent candidates; an outside target uses the raw target only as a document-relocation candidate and never as an Explorer path;
- only schedule a candidate if that logical directory is currently represented and has been loaded/error-read enough to reconcile;
- hints below a never-loaded directory are ignored structurally until ordinary lazy loading reaches that directory;
- for a loaded-but-collapsed represented parent, a direct relevant hint may still reconcile it;
- root-self mutation is not trusted to watcher coverage and is handled by root periodic/read recovery.

Symlink targets outside root may not emit through the root watch. Expanded symlink logical nodes still participate in periodic direct-child reconciliation using their logical path, which is sufficient for eventual consistency.

### 7. One Explorer reconciliation primitive owns all directory reads

Refactor `ExplorerController` so existing lazy load, Manual Refresh, watcher reconciliation, re-expansion and periodic requests all use one internal read/reconcile mechanism.

Required per-directory coordination:

```text
represented directory node
├── current node/read generation
├── inFlight read (0 or 1 authoritative background read)
├── dirtyAgain flag/generation
└── latest requested priority/source
```

Behavior:

- a duplicate background request joins/marks dirty instead of launching parallel work;
- a newer explicit Manual Refresh/read token supersedes older background apply rights;
- if a relevant hint arrives during read, run at most one follow-up read after completion unless newer hints continue to make it dirty;
- collapse/expand UI state is not overwritten by read completion;
- context/subtree relocation/removal invalidates old-path read tokens;
- I/O need not be physically cancellable; inability to commit is sufficient.

Manual Refresh continues to gather **all loaded directories including collapsed** and passes them through this same primitive. It still cancels inline edit first.

Periodic gathers only root + currently expanded loaded/error directories.

Re-expanding a cached loaded directory renders cache immediately and enqueues a normal-priority reconciliation without clearing the cache first.

### 8. Reconcile snapshots and match relocation by object identity

Add pure helpers in `explorerReconciliation.ts` to compare current represented direct children with one or more fresh directory listings.

For each target parent produce:

```text
unchanged
added
removed
same-parent rename candidates
```

Across the directories in one reconciliation batch, match `removed` and `added` entries with the same non-null `objectIdentity` and compatible entry kind as confirmed relocation. Identity-only matching is valid only when the candidate is unambiguous within that batch. Hard links can legitimately produce several logical entries with one native object id; if several removed/added candidates share a token, do not collapse them unless a paired source/target watcher candidate narrows the exact logical paths and the target identity confirms the same object. A paired watcher rename hint may narrow candidates but is never proof on its own.

A target parent that is not represented must **not** be loaded merely to preserve Tree continuity. In that case the visible Explorer side falls back to removal/addition-as-later-loaded, but a paired source/target hint may still be offered as a **document-only relocation candidate**. DocumentManager then proves each affected destination against the document binding's resolved-target `objectIdentity` before adopting it. This allows an open document to follow a provable move within/out of the Workspace without turning the target Tree branch into background-loaded state. A move into the Workspace is opportunistically rebound only when an actual source+target candidate reaches 006; ordinary target Create does not scan all outside open documents by object identity.

Rules:

- same-parent confirmed rename: reuse node object, update name/path casing, preserve directory cache/expanded state;
- cross-parent confirmed move where both parents participate: detach/reinsert the same node, rebase subtree paths, preserve compatible UI/cache state;
- unmatched remove: remove node/subtree and invalidate descendant read state;
- unmatched add: create a fresh node;
- object identity unavailable: remove/create;
- kind changed unexpectedly: remove/create unless the filesystem contract proves a compatible relocation.

The batch applies only if all relevant WorkContext/node generations are still valid. A stale batch applies nothing.

### 9. Directory relocation does not recursively inspect descendants

Once a directory entry's relocation is confirmed by its own object identity:

- its cached Explorer subtree paths can be rebased locally;
- currently open documents under the old directory are found from `DocumentManager.listSessions()` / manager-owned path metadata, not by walking disk descendants;
- each affected open document derives the new path by suffix rebasing;
- filesystem identity/path ownership of those few open destinations is re-inspected/preflighted as needed before manager adoption.

This is the same bounded “open sessions only” principle already used by internal 003 Rename.

### 10. Add DocumentManager external relocation API, do not reuse direct field mutation

Add a narrow external relocation entry point, conceptually:

```text
adoptExternalRelocation(...)
```

It must:

1. identify still-current affected document binding(s);
2. coordinate/wait/retry around current Open/Save/Save As/internal path mutation ownership as appropriate;
3. inspect/preflight each new destination and confirm the newly resolved **target** object identity matches the document binding continuity being adopted; do not compare a symlink Tree-entry token to a document target token as though they were the same identity domain;
4. refuse a destination already owned/reserved by a conflicting document/operation;
5. preserve document id, EditorState/history/view state/dirty;
6. update path/display/path ownership and increment binding generation only for successful per-document adoption;
7. notify existing 005 `WatchInterestChange` as a rebound so opened-document watch migrates;
8. leave a conflicting/unadopted document on its previous binding for 005 missing/conflict handling;
9. never modify the editor text itself.

For a directory relocation, adoption may succeed for non-conflicting sessions even if one descendant destination conflicts; return structured per-document results so no duplicate ownership is created.

The contract and implementation names MUST keep the two identity domains explicit:

- `entryObjectIdentity` means the no-follow identity of an Explorer directory entry and may prove Tree relocation;
- `resolvedTargetObjectIdentity` means the identity stored by the current document binding and re-inspected at the proposed destination;
- `WorkspaceWatchCoordinator` may pass the confirmed entry relocation and old/new paths, but MUST NOT relabel an `entryObjectIdentity` as a document target identity. `DocumentManager` derives the expected `resolvedTargetObjectIdentity` from the still-current binding and independently verifies the destination.

### 11. Force meaningful 005 validation after external relocation

A key data-safety issue: if external relocation writes a new `ResolvedPathIdentity` with the target's current `diskRevision` and 005 immediately performs a cheap revision comparison against that same value, content modified during the move could be incorrectly treated as already adopted.

Therefore external relocation must carry a **validation-required** reason/state. Recommended approach:

- extend `WatchInterestChange` rebound reason or coordinator registration context with `external-relocation`;
- add a `DiskValidationTrigger`/option for external relocation that reads the current supported text snapshot (or otherwise proves it against the existing saved baseline) even when the just-resolved metadata equals the new path identity;
- 005 applies the snapshot through existing `applyValidatedDiskSnapshot` semantics:
  - clean + changed -> reload;
  - dirty + baseline divergence -> `modified`;
  - content/format matches baseline -> keep dirty as-is and return external state to normal;
- only that 005 validation is allowed to clear a transient prior missing/modified condition after rebind.

Do not add a second content-comparison implementation in 006.

### 12. Harden internal Rename/Delete against external replacement

006's object identity makes one existing race safely testable: a path selected for internal Rename/Delete may be externally replaced while the user is confirming or while the operation is waiting for path reservations.

Extend the existing Explorer action flow:

```text
capture source Explorer-entry object identity
→ await dialog/path coordination
→ immediately re-read/inspect that structural entry (without following a replacement symlink)
→ entry identity mismatch / absent / wrong kind
   => fail/reconcile; do not mutate the new object
→ entry identity still matches
   => execute existing Rust rename/trash
```

Use the existing one-level parent directory read (`WorkspaceFileService.readWorkspaceDirectory`) to obtain the fresh **entry** token immediately before Rename/Delete. Root itself is not renameable/deletable, so every allowed source has a parent that can be read. Match the selected entry in that authoritative direct-child listing and compare its `objectIdentity`; do not use the resolved-target `inspectFilePath` token alone for this guard, because replacing one symlink with another symlink to the same target would otherwise look unchanged. No dedicated structural-entry IPC is needed for 006. This is not a new command path; it strengthens the existing canonical handler. If either the captured or freshly read entry identity is unavailable, continuity cannot be proven: abort before the rename/trash call, preserve the existing Tree/document state, surface the normal localized operation failure, and request/permit reconciliation. This conservative null-identity rule applies only to destructive/path-changing Rename/Delete; it does not disable browsing, reconciliation, Create, or remove/create fallback for external changes.

### 13. Periodic reconciliation and priorities

Use a centralized scheduler/timer inside `WorkspaceWatchCoordinator`.

Initial implementation parameters should be named constants and injectable in tests. A reasonable first target is:

```text
workspace event coalesce window ~100 ms
foreground periodic pass ~10 s
```

Do not encode those values in the spec contract. Adjust only if realistic validation shows the defaults are too noisy/slow.

Suggested priority order:

```text
1. user expansion / explicit user read
2. Manual Refresh
3. direct watcher hint for represented directory
4. root/expanded overflow recovery
5. periodic fallback
```

The implementation may use a small bounded read concurrency or sequential reads, but MUST keep queue size bounded and must not starve a user expansion behind a storm backlog.

Periodic pass:

- root always;
- currently expanded represented directories only;
- skip loaded-but-collapsed nodes;
- no overlapping pass; if one is active, the tick is coalesced/skipped;
- focus regain can request an immediate bounded expanded-area pass;
- background/minimized cadence reduction is optional for 006 and should not add a settings subsystem.

### 14. Overflow/event storm recovery

Normal batch:

```text
raw hints
→ unique represented parent candidates
→ reconcile those candidates
```

Storm/overflow batch:

```text
discard reliance on detailed sequence
→ mark recovery generation
→ root + currently expanded directories
→ bounded priority queue
→ direct-child reconcile
```

Never transform overflow into `refresh()` of every historical loaded directory automatically, because 003 Manual Refresh's broad loaded-tree behavior may include hundreds of collapsed cached directories. Overflow recovery is narrower by design.

### 15. Root unavailable and recovery

Keep WorkContext identity stable:

- root read failure -> `WorkContextManager.setRootUnavailable(true)` / existing Explorer state;
- external root move is not followed;
- periodic/focus/manual direct root read retries original path;
- if the same original path becomes readable again **and still resolves to the stored canonical WorkContext comparison identity** -> clear unavailable, reconcile root, restart watcher if degraded; if a root symlink/junction now resolves somewhere else, keep the current context unavailable until the user explicitly Open Folder chooses that new canonical root;
- duplicate Open Folder of same canonical root remains a no-op except it may prove/read recoverability through existing 003 behavior.

Do not search parent directories for a moved root and do not infer a new root from native file id in 006.

### 16. Inline edit and interaction-state rules

Automatic reconciliation is less destructive than Manual Refresh:

- unrelated structural change -> leave `inlineEdit` intact;
- edit target removed/relocated or parent context gone -> cancel that inline edit before apply;
- surviving selection remains;
- confirmed relocation updates selected path;
- deleted selection clears;
- read completion never forces expanded/collapsed state to what it was at request start.

Manual Refresh continues to cancel inline edit first, per 003.

### 17. Symlink/junction semantics

Keep two identities separate:

```text
logical Tree position/path
!=
filesystem object identity
```

The same target may be shown in multiple logical branches. Cycle detection continues to use the canonical ancestor chain already implemented by 003. A global object-id “visited” set is forbidden because it would suppress valid non-cyclic link views.

For expanded link targets outside the Workspace root, automatic realtime hints are best-effort; the periodic direct-child read and Manual Refresh guarantee eventual convergence of represented state.

### 18. App integration

`App.tsx` owns composition/lifecycle only:

- construct one `WorkspaceWatchCoordinator` beside `OpenedDocumentWatchCoordinator`;
- share `tauriFilesystemWatcher` and WorkContext/Explorer manager instances;
- start/dispose it with the app lifecycle in the same restart-safe style required by React Strict Mode;
- forward focus regain if not already exposed through an existing lifecycle adapter;
- do not mirror coordinator state into React unless a real UI projection is required (normal synchronization is silent).

No new visible toolbar/notification is required for 006.

## IPC / Contract Strategy

No second event channel is necessary. Reuse:

```text
start_filesystem_watch
stop_filesystem_watch
filesystem-watch-event
```

Expected wire changes are limited to identity/coverage/path-mapping needs:

1. `ResolvedPathIdentity` adds optional opaque `objectIdentity`.
2. `WorkspaceDirectoryEntry` adds optional opaque `objectIdentity`.
3. `WatchEvent` keeps raw `path`/`renameTarget` and adds nullable per-subscription `relativePath` / `renameTargetRelativePath` so 006 can rebase canonical watcher output onto the logical Workspace root without frontend path guessing.
4. `WatchInvalidated { scope, watchedPath, reason }` is preserved; invalidation routing is corrected so mixed recursive/non-recursive consumers receive logical-scope loss-of-completeness semantics.

Any changed DTO MUST have matching Rust serialization tests and TypeScript adapter/service tests. 005 may ignore the new relative-path fields, but its decoder tests must pin them so Rust/TypeScript stay synchronized.

## Data Ownership

- **Rust filesystem layer** owns native object identity, directory listings, canonical path semantics and watcher coverage.
- **Filesystem watcher service** owns typed IPC subscription/listener adaptation only.
- **WorkspaceWatchCoordinator** owns Workspace watch generation, event batching, periodic timer/storm scheduling and requests for reconciliation.
- **ExplorerController** owns represented Tree structure, loaded cache, expansion, selection, inline edit and per-node reconciliation apply rights.
- **explorerReconciliation.ts** is pure logic only; it owns no mutable application state.
- **WorkContextManager** remains the sole current Workspace identity owner.
- **DocumentManager** remains sole document path ownership/binding owner.
- **OpenedDocumentWatchCoordinator/DiskValidator** remain sole external document-content validation path.

## Testing Strategy

### Rust deterministic tests

Add/extend tests for:

- filesystem-object identity token is stable across same-object rename on the test filesystem;
- delete/recreate at same path yields a different object token where the platform provides identity;
- `ResolvedPathIdentity` and `WorkspaceDirectoryEntry` serialize the new optional token correctly;
- same directory can support non-recursive 005 interest and recursive 006 interest regardless of subscription order;
- recursive coverage is not silently downgraded when non-recursive interest was first;
- removing recursive interest does not break remaining non-recursive interest;
- backend reconfiguration failure rolls back/surfaces invalidation safely;
- recursive event routing reaches the Workspace subscription while a 005 non-recursive subscription receives only its target path;
- rescan/error/global invalidation reaches affected recursive Workspace scope as well as opened-document consumers;
- paired rename still preserves target candidate without becoming identity proof.

Keep one narrowly bounded real `notify` integration test for recursive descendant observation if practical on CI; all routing/reconfiguration logic should otherwise use `RecordingBackend`.

### Frontend deterministic tests

Add/extend tests for:

- Workspace event batcher coalescing, rename candidates, invalidation, storm threshold and non-restarting window;
- Workspace coordinator open/replace/close/start failure/restart generation behavior;
- no scheduling for never-loaded deep parent;
- direct hint scheduling for loaded collapsed parent;
- periodic root+expanded selection and exclusion of collapsed loaded nodes;
- periodic non-overlap and focus-triggered bounded pass, including a fake-timer 60-second idle window with zero reads of loaded-but-collapsed directories;
- event storm/overflow narrows recovery to root+expanded represented dirs;
- a deterministic scale fixture modeling at least 100,000 unopened/collapsed descendants, including at least 50,000 under unopened `node_modules`, with 10,000 raw hints and zero recursive descendant reads;
- user expansion priority over recovery backlog, proved by inserting a user expansion while recovery work is queued and observing it complete before the remaining backlog;
- Explorer one-directory in-flight dedupe/dirty-again follow-up;
- Manual Refresh supersedes background result while still rereading all loaded nodes;
- cached re-expansion displays cache and requests reconciliation;
- collapse during read remains collapsed;
- subtree delete invalidates descendant completions;
- pure diff detects same-parent case-only rename and cross-parent move by object identity;
- unconfirmed rename degrades to remove/create;
- symlink logical duplicates are not globally collapsed;
- external file/directory relocation preserves Tree state where confirmed;
- DocumentManager external relocation preserves editor/session state, rejects ownership conflict and emits 005 rebound interest;
- external relocation forces 005 content validation before external state resolution;
- internal Rename/Delete refuses to act when source object id changed while awaiting dialog/coordination.

### Integration/manual validation

Use a disposable real frontend project; do not mutate the development repository itself.

Required manual/real-world scenarios:

1. open project with large collapsed `node_modules`, run `npm install`/package-manager activity;
2. `git checkout`/`git reset --hard` across branches with structural changes;
3. external file and directory rename/move with clean/dirty open documents;
4. case-only Windows rename;
5. delete whole loaded directory subtree;
6. temporarily rename/move Workspace root and restore the original path;
7. expand a junction/symlink branch including one whose target lies outside the root;
8. switch/close Workspaces while event traffic is active.

The observable pass condition is final Explorer/disk agreement for represented state with no UI freeze, no document loss, no duplicate session ownership and no recursive enumeration of unopened descendants.

## Migration Order

1. **Native identity + watcher compatibility foundation**: add object identity and mixed-scope watcher coverage before starting a recursive Workspace subscription.
2. **Pure reconciliation primitives**: add identity-aware snapshot diff/relocation matching without lifecycle wiring.
3. **Explorer canonical reconciliation path**: refactor lazy/read/Refresh into generation-safe deduplicated per-directory reconciliation.
4. **Workspace watcher consumer**: add batcher, root subscription lifecycle, hint-to-represented-parent mapping and periodic scheduling.
5. **Create/Delete automatic convergence**: wire basic watcher batches through Explorer.
6. **External rename/move continuity**: apply identity-confirmed Tree relocation and DocumentManager binding adoption with forced 005 post-relocation validation.
7. **Storm/overflow/degraded recovery and performance behavior**: priority/queue bounds, root+expanded recovery, watcher retry, root recovery, and the cached re-expansion rule once the shared scheduler semantics are settled.
8. **Interaction-state/race hardening**: inline edit, selection, stale descendant reads, internal Rename/Delete replacement validation.
9. **Realistic performance/manual verification + four repository gates**.

The ordering intentionally prevents a recursive Workspace subscription from being enabled before the shared watcher can safely coexist with 005.

## Complexity Tracking

| Choice | Why it is justified | Rejected simpler alternative |
|---|---|---|
| Supplemental native filesystem-object identity | The frozen 006 contract requires preserving relocation only when the same object can be proven; canonical path changes during rename and cannot prove it | Trusting rename events or metadata/content heuristics would violate “identity is truth” and can bind a document to the wrong file |
| Separate `WorkspaceWatchCoordinator` | 005 document watching and 006 Tree synchronization consume the same hint stream but own different state/truth checks | Extending `OpenedDocumentWatchCoordinator` with Workspace logic would mix document and Explorer ownership and contradict 005's extension boundary |
| Pure Explorer reconciliation helper | Multi-parent rename/move matching must be deterministic and testable without UI/watcher timing | Embedding identity matching directly in event callbacks would make watcher hints authoritative and race-prone |
| Mixed-scope watcher reconfiguration | 005 non-recursive and 006 recursive interests can legally share one directory; current first-subscriber scope assumption is false | A second watcher library/manager would duplicate infrastructure, while silently sharing the first scope would miss recursive events |
| Low-frequency periodic expanded-area fallback | Root watchers can lose events/overflow and may not cover external symlink targets; eventual consistency needs a bounded truth check | Polling every loaded/all Workspace directory would grow with historical expansion/total tree and recreate the crawler problem |

These are approved feature-required complexities, not constitution exceptions. No additional framework/index/persistence system is justified.

## Phase 0 Research Output

Repository/code-aware clarification is complete. No unresolved planning questions remain. The key research conclusions are embedded above:

- existing watcher foundation is reusable but mixed-scope sharing must be repaired;
- current canonical path identity cannot prove rename/move continuity;
- 005 consumer must remain separate;
- current Explorer Refresh/read ownership can be refactored rather than replaced.

No separate `research.md` is required for this feature.

## Phase 1 Design Output

The design is fully captured by `spec.md`, this plan and the concrete task breakdown. No new public API surface beyond the repository-internal watcher/identity/document-manager contracts requires a separate contracts document for 006. Any wire DTO change is pinned directly by synchronized Rust/TypeScript tests as required by the Constitution.

## Post-Design Constitution Check

PASS. The plan preserves all five principles. The most important review gates are: object identity remains supplemental rather than a new path owner; 006 never touches editor text; a recursive watcher never bypasses reconciliation; Workspace lifecycle generations guard every asynchronous apply; and no recovery path recursively scans the Workspace.
