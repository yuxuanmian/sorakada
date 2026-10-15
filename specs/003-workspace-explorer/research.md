# Research: Workspace and Explorer

## Decision 1: Keep filesystem structure operations on the Rust side

**Decision**: Add Rust commands for directory enumeration, create, rename, trash, and Workspace relation instead of adding frontend direct filesystem access.

**Rationale**: The existing project already centralizes text bytes and path identity in Rust. 003 requires the same canonical Windows-aware semantics for Workspace containment, symlink/junction handling, and path mutations. Keeping these operations in Rust avoids duplicating path behavior in TypeScript.

**Alternatives considered**:

- Tauri filesystem plugin from the frontend: rejected because it would split path semantics between the frontend and existing Rust identity code.
- Node-style filesystem access: unavailable/not appropriate in the Tauri WebView architecture.

## Decision 2: Use the Rust `trash` crate for normal Delete

**Decision**: Use the cross-platform `trash` crate from Rust to move files/directories to the OS recycle/trash facility. Do not permanently delete as a fallback.

**Rationale**: 003 explicitly defines Delete as recoverable and explicitly excludes permanent Delete. The crate supports the Windows Recycle Bin and other desktop trash implementations, while keeping the operation on the Rust side.

**Alternatives considered**:

- `std::fs::remove_file/remove_dir_all`: rejected because it permanently deletes.
- Trash-then-permanent fallback: rejected because a failure to trash must remain a failure under FR-066/FR-067.

## Decision 3: Model zero documents explicitly

**Decision**: Make active document identity nullable and mount no CodeMirror view when no document exists.

**Rationale**: A fake Empty-State session would leak into Save/Close/dirty/path semantics and conflict with Workspace/document independence. A nullable active identity directly represents the user-visible state.

**Alternatives considered**:

- Keep an invisible Untitled session: rejected because it would preserve the 002 invariant that 003 intentionally supersedes.
- Keep CodeMirror mounted with a synthetic state: rejected because commands and lifecycle would still have to distinguish the synthetic state from a real document.

## Decision 4: Add lightweight command availability to the existing registry

**Decision**: Each command may expose `isEnabled()`. `execute()` enforces it, and UI surfaces query the same predicate.

**Rationale**: 0-Tab, no-Workspace, root selection, and Explorer-target states make availability part of command semantics. A single predicate prevents menus and shortcuts from disagreeing.

**Alternatives considered**:

- Per-surface checks: rejected because they drift.
- Full command context/when-clause framework: rejected as premature for 003.

## Decision 5: Scope F2/Delete to Explorer instead of the global keymap

**Decision**: Handle plain `F2`/`Delete` from an Explorer-local keyboard handler, then invoke the shared command registry.

**Rationale**: A global mapping would recognize `Delete` while CodeMirror has focus and could suppress normal text deletion even if the Explorer command is disabled. Focus scoping is a trigger rule, while target validity remains the shared command availability rule.

## Decision 6: Lazy directory cache, no recursive scan/index

**Decision**: Read only direct children. Cache loaded directories until Refresh or app-originated mutations.

**Rationale**: This keeps project size, especially `node_modules`, from determining initial Workspace cost.

**Alternatives considered**:

- Recursive preload/index: rejected by scope and performance requirements.
- Auto-filter `node_modules`: rejected because 003 deliberately shows filesystem entries without ignore rules.

## Decision 7: Allow symlink/junction directory browsing with ancestor-cycle checks

**Decision**: Permit expansion, but reject recursion when the resolved canonical directory repeats a canonical path already in the current ancestor chain.

**Rationale**: Real developer trees can contain links. Blocking all directory links is unnecessarily restrictive; global graph tracking is unnecessary. Ancestor-cycle checks prevent unbounded recursion with limited state.

## Decision 8: Atomic Workspace replacement

**Decision**: Resolve and read the candidate root before replacing the current WorkContext. Apply a generation token so only the latest request may commit.

**Rationale**: Failed or stale asynchronous Open Folder requests must never destroy a working Workspace.

## Decision 9: Keep Workspace and document ownership separate

**Decision**: WorkContext never owns tabs/documents. Workspace relation is derived dynamically.

**Rationale**: Open File, Save As, Workspace replacement, and files outside the root all become straightforward. It also leaves future Locate/Search functionality based on a derived `relativePath` instead of origin metadata.

## Decision 10: Generalize path destination coordination rather than adding another independent claim map

**Decision**: Open, Save As, and Explorer path mutations participate in one compatible destination-reservation/ownership mechanism adjacent to `DocumentManager`.

**Rationale**: 002 already has separate `pendingOpens` and Save As claims. 003 adds more writers/movers, so another independent map would multiply race conditions.

**Alternatives considered**:

- Keep separate Open, Save As, Rename claims: rejected because the current Open/Save As gap is already a known race.
- Build a generic transaction engine: rejected as too broad.

## Decision 11: Do not mandate Tree virtualization yet

**Decision**: Keep virtualization as an implementation optimization triggered by realistic testing of very large direct-child directories.

**Rationale**: Lazy loading solves the much larger recursive project-size problem. Virtualization should be added only if rendering one loaded directory becomes measurably unusable.
