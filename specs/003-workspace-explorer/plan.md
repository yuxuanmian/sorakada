# Implementation Plan: Workspace and Explorer

**Branch**: `003-workspace-explorer` (planned, based on current `feature-core`)  
**Date**: 2026-09-18  
**Spec**: `specs/003-workspace-explorer/spec.md`  
**Implementation Base Reviewed**: `feature-core` @ `95e6d2d130dedbb5a925a25c88017191101f193a`

## Summary

003 adds a single-root Workspace/WorkContext, a lazy Explorer, basic filesystem operations, zero-document Empty State, command availability, and a stable Sidebar/Editor shell on top of the 002 multi-document editor.

The implementation keeps Workspace state independent from `DocumentSession`, reuses `DocumentManager.openPath()` for every file-open entry point, and keeps filesystem/path semantics on the Rust side. The Explorer only loads directories the user actually opens or that were previously loaded and explicitly refreshed; no recursive Workspace scan, watcher, search index, Git integration, session restore, or multi-root support is introduced.

The first implementation phase also fixes three 002 consistency gaps that would otherwise make 003 path mutations unsafe:

1. Open and Save As must participate in compatible destination reservation/ownership rules.
2. Close/exit must re-check dirty state after a successful save before discarding a document.
3. Save As must not advance the saved baseline when destination adoption fails.

## Technical Context

**Frontend Language/Version**: TypeScript `~6.0.3`  
**Frontend Framework**: React `^19.1.0`  
**Editor**: CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`)  
**Desktop Runtime**: Tauri 2  
**Backend Language**: Rust 2021 edition  
**Build Tooling**: Vite `^8.0.16`, Tauri CLI 2  
**Testing**: Vitest `^4.1.11`, Rust `cargo test`  
**Storage**: Local filesystem only; no database  
**Target Platform**: Windows-first desktop; avoid unnecessary Windows-only frontend assumptions  
**Performance Goal**: Workspace cost scales with loaded directories, not total descendant file count. Opening a project with a large `node_modules` tree must not recursively enumerate it.  
**Constraints**: One `EditorView`; CodeMirror owns live text; React only renders document metadata; raw byte encoding/EOL handling stays in Rust; no watcher/index/session persistence in 003.

## Constitution Check

The uploaded `.specify/memory/constitution.md` is still the unfilled template and therefore defines no enforceable project-specific gates. The repository's `AGENTS.md` provides the effective implementation constraints for this feature:

- Do not edit text files through Windows PowerShell 5.1 encoding-guessing cmdlets.
- Preserve the existing frontend/Rust IPC contract discipline.
- Run all four completion checks: `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` under `src-tauri`.
- CodeMirror remains the owner of live document text; do not mirror editor text into React state.
- Only successful disk writes/path mutations may advance committed document/path state.

**Gate result**: PASS. The design below preserves these constraints.

## Design Decisions

### 1. Application state becomes two independent axes

The application can independently have:

- zero or one active `WorkContext`; and
- zero or more open `DocumentSession`s.

All four combinations are valid. Workspace lifecycle never implicitly opens, saves, closes, or discards documents. Document lifecycle never implicitly creates or replaces a Workspace.

### 2. Zero-document state is a first-class document-model state

`DocumentManager.activeDocumentId` becomes nullable. The constructor no longer creates `Untitled1`. Closing the final document sets the active identity to `null` and emits a zero-tab snapshot.

`getActiveSession()` becomes nullable (or is paired with an explicit nullable accessor), and callers must not assume an active document. The shared CodeMirror `EditorView` exists only while at least one document is open. The UI renders an `EmptyState` when there is no active document; the Empty State is not represented by a fake session.

The one-view invariant still holds while documents exist: Tab switching swaps `EditorState` into one shared `EditorView` and does not recreate the editor. A zero-to-one transition mounts the shared editor; a one-to-zero transition unmounts/detaches it.

### 3. Command availability is added without building a command framework

Extend the existing registry so each command can expose an optional `isEnabled()` predicate. The registry provides `isEnabled(id)` and `execute(id)` refuses/no-ops a disabled command.

All command surfaces consult the same predicate:

- native File/View menu state;
- Tab/Empty State buttons when applicable;
- Explorer context menu/header actions;
- keyboard dispatch.

Native menu installation keeps references to menu items and exposes a small `syncAvailability()` function. `App` invokes it when document, Workspace, or Explorer operation state changes.

Plain Explorer keys (`F2`, `Delete`) are handled by an Explorer-scoped key handler only while Explorer has keyboard focus, then dispatch through the same registry. They must not be added to the global Ctrl/Meta keymap because doing so would swallow normal editor `Delete` when the editor has focus.

### 4. WorkContext owns Workspace identity, not documents or Tree state

Introduce a small `WorkContextManager` with a nullable active context and an open-generation token.

A context contains:

- process-local `id`;
- user-facing root path;
- canonical root path;
- comparison key;
- display name.

Opening a folder is atomic:

1. choose/receive the directory path;
2. resolve canonical identity;
3. if its comparison key already matches the active context, return a no-op without rebuilding/reloading Explorer solely for the duplicate request;
4. verify a different candidate is a directory;
5. read its direct children successfully;
6. only then replace the active context and Explorer root.

If preparation fails, the previous context remains active. Overlapping opens use last-intent-wins generation checks.

### 5. Workspace relation stays derived and filesystem-aware

Do not persist `isInWorkspace` or a Workspace owner on `DocumentSession`.

Add a Rust-side path relation operation that derives:

- `unbound` for no document path (handled directly by the caller without IPC);
- `inside` with `relativePath`; or
- `outside`.

The relation uses canonical/component-aware path semantics. It must not use frontend `startsWith()` checks. This same relation primitive is reused when identifying open documents underneath a directory for Rename/Delete.

### 6. Explorer model is separate from filesystem access and UI

Introduce three layers:

- **Workspace filesystem service**: Tauri invoke wrappers only.
- **Explorer model/controller**: selected path, expanded nodes, load/cache/error state, context generation, inline edit state, and mutation reconciliation.
- **Explorer React UI**: tree rendering, clicks, resize, context menu, inline editor, and focus state.

A directory node has at least:

- path/name/type;
- symlink flag;
- expanded state;
- `not-loaded | loading | loaded | error` load state;
- cached direct children when loaded;
- resolved canonical directory path after a successful directory read.

Only one inline create/rename editor is active at a time. WorkContext replacement or Refresh cancels the uncommitted inline editor.

### 7. Directory browsing is lazy and cache-based

Opening a Workspace reads only the selected root's direct children. Expanding an unloaded directory reads only that directory. Re-expanding a loaded directory reuses cached children.

Refresh rereads every directory that is already in `loaded` state, including loaded-but-collapsed directories, and does not load previously unseen descendants. Expanded state is restored for surviving paths. Selection is preserved only if the selected path still exists.

No implementation may use a recursive walker merely to open or refresh a Workspace.

### 8. Symlink/junction traversal allows browsing with ancestor-cycle protection

Directory enumeration identifies whether an entry is a link and whether its target behaves as a directory. The directory-read result also returns the canonical identity of the directory actually read.

Before accepting an expanded directory's children, the Explorer compares that resolved canonical path with the canonical paths of its current ancestor chain. If it repeats an ancestor, the node becomes a non-recursing/cycle state and no further children are followed.

This is intentionally ancestor-chain protection, not a global link graph. A link to a directory already visited elsewhere in another branch remains browsable if it does not create a cycle in the current path.

### 9. Filesystem mutation commands live in Rust

Keep byte-oriented text read/write behavior in `file_codec.rs`. Add a separate Workspace/filesystem command module for metadata and structural operations:

- read one directory;
- create one empty file;
- create one directory;
- rename one entry without overwrite;
- move one entry to the OS recycle/trash facility;
- resolve Workspace relation.

Frontend requests for create/rename pass a parent/source path and a single leaf name rather than arbitrary concatenated destination strings. Rust validates that the name is one path component; platform-specific invalid/reserved names are ultimately reported through filesystem errors.

Deletion uses the Rust `trash` crate and **must not** fall back to permanent deletion when trashing fails. A trash failure is reported as a failed Delete because FR-066/FR-067 prohibit permanent deletion in 003.

### 10. Explorer open actions reuse DocumentManager

Explorer double-click, File > Open, and drag/drop all converge on `DocumentManager.openPath()`.

Explorer single-click never opens a document. Tab changes never mutate Explorer selection/expansion/scroll. Dropped directories remain ignored. Dropped Workspace files are opened like any other file and do not auto-locate their Tree node.

### 11. File > New and Explorer creation remain separate concepts

`file.new`, Ctrl+N, and TabBar `+` always call `DocumentManager.createUntitled()`.

Workspace disk creation is exposed through Explorer actions (`explorer.newFile`, `explorer.newFolder`) and derives its parent from persistent Explorer selection:

- selected directory -> inside that directory;
- selected file -> selected file's parent;
- root/no concrete node -> Workspace root.

A successful new file is selected and opened via `openPath()`. A successful new directory is selected only.

### 12. Right-click selection defines the operation target

The custom Explorer context menu is intentionally small and non-extensible in 003.

- right-click node -> select it first, then open menu;
- right-click blank area -> clear concrete selection and use Workspace-root context;
- root context -> New File, New Folder, Refresh; no Rename/Delete;
- directory context -> New File, New Folder, Rename, Delete, Refresh;
- file context -> New File, New Folder, Rename, Delete.

Header, root-context and directory-context Refresh invoke the same loaded-tree operation; directory context does not trigger a separate recursive or subtree scan.

Context menu, header buttons, and command handlers use one `FileOperationContext` derivation path.

### 13. Rename is disk-first and preserves live document identity

Rename flow:

1. derive operation target and new leaf name;
2. resolve/claim destination ownership;
3. wait for/coordinate relevant in-flight path operations;
4. perform the Rust filesystem rename;
5. re-resolve identities for affected open documents;
6. commit `DocumentSession` path/pathIdentity/displayName changes without replacing document ids or editor states;
7. update Explorer state and selection.

For directory Rename, update every currently open document under the old directory. The number of open sessions is small, so checking sessions is allowed; the directory contents must not be recursively scanned for this purpose.

### 14. Delete is confirmation-first, trash-first, then state removal

Delete must not call ordinary `closeDocument()` after disk deletion because the normal close flow may prompt to Save and recreate the file.

Delete flow:

1. determine affected open sessions from their paths only (no recursive disk scan);
2. wait for relevant in-flight saves/path mutations to settle;
3. show confirmation; if any affected session is dirty, use explicit discard wording;
4. after the dialog returns, re-check affected dirty state before disk mutation; if a previously clean target became dirty while the dialog was open, require the dirty-warning confirmation before continuing;
5. move the target to OS trash;
6. only after trash succeeds, remove affected document sessions through a no-second-prompt manager API;
7. update Explorer selection/tree.

Failure at step 5 leaves document and Explorer state intact.

### 15. Path ownership/reservation is unified before Explorer mutation work

Refactor the 002 destination coordination so Open, Save As, and Explorer path-changing operations cannot independently claim the same canonical destination.

Required behavior:

- an Open in progress reserves its resolved comparison key until registration fails or succeeds;
- Save As/rename targeting a reserved/open path waits or fails deterministically rather than creating duplicate ownership;
- an Open that races a path-changing operation does not register a stale duplicate session;
- destination claims are released only by the generation/operation that owns them;
- source-side directory Rename/Delete coordinates with pending opens/saves under that source so stale completions cannot register or restore old paths.

Keep this coordination inside/adjacent to `DocumentManager`; do not create a general transaction framework.

### 16. Repair 002 save/close safety before using it from 003

`commitSave()` must not advance `savedBaseline` for a Save As whose destination adoption did not succeed.

`closeDocument()` and `prepareCloseAll()` must re-fetch/re-check a document after Save returns. If newer edits made it dirty again, the close decision is not complete; the dirty guard repeats/continues rather than discarding those edits.

These changes are regression-tested independently before Explorer Rename/Delete relies on them.

### 17. AppShell is introduced as composition, not a registry

Restructure the React shell conceptually as:

```text
App
└─ AppShell
   ├─ Header
   └─ Body
      ├─ Sidebar
      │  └─ Explorer
      └─ EditorArea
         ├─ TabBar
         │  ├─ TabScrollArea
         │  └─ NewDocumentButton
         └─ EditorHost | EmptyState
```

`Sidebar` is not named/implemented as an Explorer-only permanent container. 003 stores only transient `sidebarVisible` and `sidebarWidth` state. No layout persistence or panel registry is added.

Continue the existing CSS custom-property token approach. Add a small centralized `AppIcon` component rather than scattering SVG definitions.

## Planned Source Layout

```text
src/
├─ app/
│  ├─ App.tsx                         # integration/composition only
│  ├─ commands/
│  │  ├─ commandIds.ts                # new workspace/explorer/view ids
│  │  ├─ commandRegistry.ts           # execute + isEnabled
│  │  └─ ideaKeymap.ts                # global Ctrl/Meta mappings only
│  ├─ document/
│  │  ├─ documentManager.ts            # nullable active doc + path coordination APIs
│  │  └─ documentSession.ts            # nullable snapshot activeDocumentId
│  ├─ workspace/
│  │  ├─ workContext.ts
│  │  ├─ workContextManager.ts
│  │  └─ workContextManager.test.ts
│  ├─ explorer/
│  │  ├─ explorerModel.ts
│  │  ├─ explorerController.ts
│  │  ├─ explorerActions.ts
│  │  ├─ Explorer.tsx
│  │  ├─ ExplorerTree.tsx
│  │  ├─ ExplorerContextMenu.tsx
│  │  └─ *.test.ts
│  ├─ shell/
│  │  ├─ AppShell.tsx
│  │  ├─ Sidebar.tsx
│  │  ├─ EmptyState.tsx
│  │  └─ AppIcon.tsx
│  ├─ tabs/
│  │  └─ TabBar.tsx
│  ├─ menu/
│  │  └─ appMenu.ts
│  ├─ dragdrop/
│  │  └─ fileDropController.ts
│  └─ window/
│     └─ windowLifecycle.ts
├─ services/
│  ├─ fileService.ts                  # existing text/path identity service
│  ├─ fileDialogs.ts                  # existing document dialogs
│  ├─ workspaceFileService.ts         # structural filesystem IPC adapter
│  └─ workspaceDialogs.ts             # folder/delete confirmation UI
└─ styles/
   ├─ global.css
   ├─ tabs.css
   ├─ shell.css
   └─ explorer.css

src-tauri/src/
├─ commands/
│  ├─ file.rs                         # existing text/path inspection commands
│  ├─ workspace.rs                    # new structural filesystem commands
│  └─ mod.rs
├─ file_codec.rs
├─ file_identity.rs                   # shared identity/containment helpers
├─ workspace_fs.rs                    # read/create/rename/trash primitives
└─ lib.rs                             # command registration
```

Exact file splitting may be adjusted during implementation if a module remains small; the boundaries above are the intended ownership boundaries, not a requirement to create empty abstractions.

## IPC / Contract Strategy

The Tauri boundary remains typed and explicitly tested from both sides. New contract shapes are documented in `contracts/workspace-ipc.md`.

Important guarantees:

- directory reads are one-level only;
- returned directory identity is canonical and can be used for cycle checks;
- create/rename do not overwrite existing targets;
- trash never silently falls back to permanent deletion;
- path relation is canonical/component aware;
- all errors keep a stable `code + message` shape suitable for frontend handling.

## Data Model

See `data-model.md` for the full state model. The central ownership rules are:

- `DocumentManager` owns documents and canonical destination ownership.
- `WorkContextManager` owns only current Workspace identity/generation.
- `ExplorerController` owns transient Tree/UI state for the active context.
- Rust owns filesystem truth and path semantics.

No document is owned by a Workspace.

## Testing Strategy

### Automated frontend tests

Use Vitest for:

- nullable document lifecycle and Empty State-facing snapshots;
- command availability/disabled execution;
- 002 path ownership and close/save regressions;
- WorkContext open/replace/no-op/last-intent behavior;
- Explorer lazy loading/cache/stale-generation handling;
- operation-context target derivation;
- create/rename/delete orchestration with mocked filesystem/document services;
- right-click selection semantics;
- Refresh reconciliation;
- drag/drop file/directory behavior.

### Automated Rust tests

Use `cargo test` for:

- directory read IPC shape and direct-child-only behavior;
- entry sorting metadata and symlink/junction identification;
- canonical root/target relation and sibling-prefix rejection;
- create file/folder conflict/failure behavior;
- rename no-overwrite behavior;
- recycle/trash error propagation without permanent fallback;
- link/canonical identity behavior needed for ancestor-cycle protection.

### End-to-end / quickstart validation

Use `quickstart.md`. In particular, validate against a disposable copy of a real frontend project containing `node_modules`. Do destructive New/Rename/Delete testing only in a copy/scratch Workspace.

The key performance assertion is behavioral: opening the Workspace and browsing `src` must not enumerate unopened `node_modules` descendants. If a single expanded directory has an extreme number of direct children and rendering is measurably unusable, add Tree virtualization as an implementation optimization without changing the spec contract.

## Migration Order

1. **Safety foundation**: fix 002 path ownership and save/close consistency; add command availability.
2. **Zero-document model**: remove mandatory initial/last Untitled, make active document nullable, update Editor/window/menu behavior.
3. **Workspace filesystem contract**: Rust one-level directory/read/create/rename/trash/relation operations and frontend adapters.
4. **WorkContext + Explorer browsing**: atomic Workspace open, generation checks, lazy model, Sidebar shell.
5. **Document integration**: Explorer open and drag/drop relation handling.
6. **Create/Rename/Delete**: inline operations, path coordination, document path/session updates.
7. **Refresh/context menu/polish**: reconciliation, right-click/focus keyboard actions, realistic performance validation.

This order keeps data-safety invariants ahead of every feature that depends on them.

## Complexity Tracking

| Choice | Why it is justified | Rejected simpler alternative |
|---|---|---|
| Separate `WorkContextManager` and Explorer state | Workspace identity and Tree UI have different lifetimes and async-generation rules | Putting expansion/selection into WorkContext would couple identity to transient UI and make replacement harder |
| Rust-side Workspace relation | Windows canonical/path-component semantics must match 002 identity rules | Frontend string-prefix comparison is incorrect for sibling prefixes, case rules, and links |
| Shared command availability predicate | Zero-document and Workspace contexts create real disabled states across menu/keyboard/context menu | Duplicating checks per surface can drift and permit disabled shortcuts |
| OS trash dependency | Spec explicitly requires recoverable Delete and prohibits permanent fallback | `std::fs::remove_*` would violate the product contract |
| Unified destination coordination | 003 adds Rename/Delete to the same canonical destinations already touched by Open/Save As | Separate reservation maps already expose an Open/Save As race in 002 |

No plugin/panel framework, watcher, index, multi-root abstraction, or generic transaction system is justified for 003.

## Phase 0 Research Output

Research decisions are recorded in `research.md`. There are no unresolved `NEEDS CLARIFICATION` items.

## Phase 1 Design Output

Generated design artifacts:

- `data-model.md`
- `contracts/workspace-ipc.md`
- `contracts/command-availability.md`
- `quickstart.md`

## Post-Design Constitution Check

PASS. The planned design continues to respect repository constraints, keeps CodeMirror text ownership unchanged, keeps byte/encoding work in Rust, and adds only the minimum new state managers/services required by the 003 feature.
