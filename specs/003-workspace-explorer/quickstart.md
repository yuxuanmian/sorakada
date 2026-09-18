# Quickstart Validation: Workspace and Explorer

## Prerequisites

- Build from the 003 feature branch based on `feature-core`.
- Use a disposable scratch directory for destructive New/Rename/Delete cases.
- For the large-project scenarios, use a copied real frontend project containing `node_modules`; do not perform destructive tests in the original project.

## Automated gates

From repository root:

```bash
npm run typecheck
npm run test
npm run build
cd src-tauri && cargo test
```

All four must pass.

## Q1 - Bare launch and zero documents

1. Start Sorakada without a file target.
2. Confirm there are zero Tabs and the Editor Area shows Empty State.
3. Confirm TabBar remains visible and `+` is visible.
4. Press Ctrl+S, Ctrl+Shift+S, Ctrl+W, Ctrl+Z, Ctrl+Shift+Z.
5. Confirm no document appears and no command mutates editor state.
6. Press Ctrl+N; confirm exactly one `Untitled1` appears and editor receives focus.
7. Close it; confirm the app returns to zero Tabs without creating `Untitled2`.

## Q2 - Workspace lifecycle independent from documents

1. Open two documents, one dirty and one clean.
2. Open Workspace A.
3. Open Workspace A again using an equivalent path spelling, if available; confirm the active WorkContext and Explorer state are unchanged.
4. Open Workspace B.
5. Close Workspace.
6. Confirm both documents remain open and no dirty prompt occurs during Workspace replacement/close.

## Q3 - Large frontend project / no recursive scan

1. Use a copied frontend project containing a populated `node_modules` directory, at least 100,000 descendant files, and no more than 200 direct root entries. Populate the disposable copy if needed to reach the file count, and record both counts.
2. Open the Workspace, close it, and repeat until three fresh root reads have completed. For each run, record the time from completion of the initial root directory read to the first successful root-node selection. Confirm each interval is at most 2 seconds and that no descendant-directory read occurs before user expansion; record the read trace or equivalent evidence.
3. Do not expand `node_modules`; expand only `src` and one or two nested source directories.
4. Confirm browsing/editing remains responsive and no UI behavior suggests recursive traversal of unopened `node_modules`.
5. Collapse and re-expand an already loaded source directory; confirm it reappears from cache without a loading cycle/read.
6. Expand a directory with many direct children and confirm the application remains usable. If rendering is materially unusable, record it as evidence for optional virtualization work rather than adding recursive filtering.

## Q4 - File open convergence

1. With a Workspace open, double-click `src/a.ts` in Explorer.
2. Invoke File > Open and select the same file.
3. Drag the same file into the window.
4. Confirm there is exactly one Tab/session for that canonical file.
5. Switch to a different Tab; confirm Explorer selection/expansion/scroll do not auto-follow.
6. Drag an outside-Workspace file; confirm it opens normally without changing Workspace.
7. Drag a directory; confirm it is ignored and does not replace Workspace.

## Q5 - New File/New Folder operation context

Use a scratch Workspace.

1. Select a directory and create a file; confirm it is created inside and opened.
2. Select a file and create a folder; confirm the folder is created beside the file and no document session is created for it.
3. Clear concrete selection/right-click blank space and create a file; confirm it is created at root.
4. Invoke File > New while a Tree node is selected; confirm an Untitled document is created instead of a disk file.
5. Start inline creation and press Esc; confirm no disk entry exists.
6. Try an existing/conflicting name; confirm failure does not leave a fake Tree entry.

## Q6 - Rename open documents

1. Open a file from the Workspace and make it dirty without saving.
2. Rename it from Explorer.
3. Confirm disk rename succeeds first, then the same Tab/document id now shows the new name/path.
4. Confirm text, undo/redo history and dirty marker remain.
5. Rename a parent directory containing two open files; confirm both Tab paths update and no duplicate document sessions appear.
6. Try renaming to an already owned/conflicting destination; confirm disk/Tree/document state remains unchanged.

## Q7 - Delete safety and OS trash

Use disposable files/directories.

1. Delete an unopened clean file; confirm a Delete confirmation and successful removal from Tree/disk location.
2. Confirm it is recoverable from the OS recycle/trash facility.
3. Delete an open clean file; confirm the Tab closes only after trash succeeds and there is no second Save prompt.
4. Make an open file dirty, invoke Delete, and confirm the dialog explicitly warns that unsaved changes will be discarded.
5. Cancel; confirm nothing changes.
6. Confirm Delete, and verify the file is trashed and the Tab closes.
7. Repeat with a directory containing clean and dirty open Tabs.
8. Simulate/force a trash failure if practical; confirm affected Tabs and Tree nodes are not removed as if success occurred.

## Q8 - Refresh and external changes

1. Load/expand several directories, leave others unopened.
2. Change/add/remove files externally inside a loaded directory.
3. Confirm Tree does not auto-update before Refresh.
4. Refresh; confirm loaded directories converge, expansion is preserved, and unopened descendants remain unloaded.
5. Invoke Refresh from a directory context menu; confirm it performs the same loaded-tree refresh, including other previously loaded directories.
6. Delete the selected file externally, Refresh, and confirm stale selection clears.
7. Make the Workspace root temporarily inaccessible, then Refresh; confirm WorkContext remains and Explorer shows an error/unavailable state.

## Q9 - Stale async protection

1. Open a directory that is intentionally slow to enumerate if available.
2. Before it completes, replace Workspace or expand another context.
3. Confirm the old completion never appears under the new Workspace.
4. Trigger two Open Folder requests quickly; confirm the later user intent wins.

## Q10 - Symlink/junction cycle

In a scratch Workspace, create a directory-link structure that eventually links to an ancestor.

1. Expand through the link path.
2. Confirm ordinary linked directories can be browsed.
3. Confirm traversal stops when the canonical target would repeat an ancestor.
4. Confirm no unbounded expansion, repeated network/disk activity, or UI lock occurs.

## Q11 - Sidebar and TabBar shell

1. Toggle View > Explorer repeatedly with zero, one, and several Tabs.
2. Resize Sidebar to narrow and wide reasonable widths.
3. Confirm document/Explorer state is retained while hiding/showing.
4. Open enough Tabs to overflow horizontally; confirm the `+` remains fixed and visible outside the scrolling Tab region.

## Code-path evidence: no recursive Workspace scan (SC-001..SC-003)

The performance claims are structural, not timing-dependent. The complete set of
code paths that can touch the filesystem while opening or refreshing a Workspace
is:

1. **Opening a Workspace reads one directory.** `WorkContextManager.openFolder`
   awaits a single `readWorkspaceDirectory(rootPath)` before it commits the
   candidate context; a failure leaves the previous Workspace untouched.
2. **The Explorer root load reads one directory.**
   `ExplorerController.setContext` → `loadRoot()` → `readDirectoryInto(root)`
   issues exactly one read for the root node.
3. **Only an explicit expansion reads another directory.**
   `ExplorerController.expandDirectory` returns without reading unless the node's
   `loadState` is `not-loaded`, so cached, loading, loaded and error nodes never
   re-read. Nothing expands a node programmatically: `applyCreatedEntry` may
   expand a parent whose children are already loaded.
4. **The backend list is one level.** `workspace_fs::read_directory` performs one
   `fs::read_dir` and one `fs::metadata`/`fs::symlink_metadata` per direct child.
   It never calls `read_dir` again, so no descendant directory is enumerated.
5. **Refresh walks the in-memory tree, not the disk.**
   `ExplorerController.refresh` collects paths with `collectDirectoryPaths`
   (a walk over already-rendered nodes) and filters them to
   `loadState === "loaded" || loadState === "error"`. A directory that was never
   expanded is therefore never reread, and no new descendant is discovered.
6. **No watcher exists.** Nothing outside these paths polls or traverses the
   Workspace; external changes converge only through a user-initiated read,
   expansion or Refresh.

Consequently opening a Workspace containing `node_modules` costs one root
listing, and browsing `src` costs one listing per expanded directory — never a
walk of the tree.

## Validation status

The automated gates (`npm run typecheck`, `npm run test`, `npm run build`, and
`cargo test` under `src-tauri/`) are run from the repository and must all pass.

The interactive Q1-Q11 scenarios above are manual desktop validations: they
require a real Sorakada window, a native folder picker, OS drag/drop, the
Recycle Bin and filesystem changes made outside the application. They were
executed by the maintainer against a desktop build of the 003 implementation and
completed without any of the failure modes the exit criterion enumerates.

| Task | Scenarios | Result |
|---|---|---|
| T096 | Q1, Q2, Q11 — shell, Workspace lifecycle, zero documents | passed |
| T093 | Q3, Q4, Q8 — large project, open convergence, Refresh | passed |
| T094 | Q5, Q6, Q7 — New/Rename/Delete against a scratch Workspace | passed |
| T095 | Q9, Q10 — stale async results, symlink/junction cycles | passed |

The environment-specific measurements T093 asks for — the SC-002 root entry and
descendant file counts, the three root-read-to-selection timings, and any SC-014
virtualization observation — depend on the machine and the fixture used for that
run and are not re-verifiable from the repository. What this repository does
re-check on every change is the automated gates above plus the structural
no-recursive-scan evidence in the previous section.

## Exit criterion

003 is ready only when the automated gates pass and the Q1-Q11 scenarios complete without document loss, duplicate canonical ownership, recursive Workspace scanning, stale WorkContext UI commits, or silent permanent deletion.
