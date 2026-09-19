# Implementation Plan: Interaction Polish

**Implementation Branch**: `feature-core` (intentionally retained; Spec Kit feature pointer: `specs/004-interaction-polish`)  
**Date**: 2026-09-19  
**Spec**: `specs/004-interaction-polish/spec.md`  
**Implementation Base Reviewed**: `feature-core` @ `690f285cb2cb9976682b8583e145f7d99e5890ac`

## Summary

004 is a deliberately narrow frontend follow-up to the completed 003 Workspace/Explorer feature. It changes five interaction/rendering details only:

1. Directory rows become selection-on-single-click and expand/collapse-on-double-click; chevrons remain expansion-only controls.
2. File context menus stop showing New File/New Folder, while the existing selected-file parent-target rule remains valid for Explorer-header creation.
3. Inline New/Rename editors cancel on ordinary blur before commit, but Enter establishes a commit attempt that blur cannot cancel; a retained failed attempt regains input focus.
4. The TabBar `+` moves into the scrolling Tab strip immediately after the final Tab.
5. CodeMirror partial-line selection remains visible even where the active-line background overlaps it.

No filesystem architecture, path identity, document lifecycle, Workspace lifecycle, command ids, Rust IPC, or package/runtime strategy is redesigned.

## Technical Context

**Frontend Language/Version**: TypeScript `~6.0.3`  
**Frontend Framework**: React `^19.1.0`  
**Editor**: CodeMirror 6  
**Desktop Runtime**: Tauri 2 / system WebView2 Evergreen  
**Backend**: Rust 2021, unchanged by design in this feature  
**Testing**: Vitest `^4.1.11`, existing repository verification commands, focused manual Tauri validation  
**Implementation Scope**: Frontend interaction/event wiring, context-menu presentation filtering, inline commit-result signaling, TabBar layout, editor theme styling  
**Performance Goal**: No new filesystem reads from directory selection; no new recursive work; no added render architecture or persistent state.

## Repository / Agent Constraints

The implementation agent MUST preserve the completed 003 design unless this 004 spec explicitly supersedes it.

### Hard no-design-drift rules

The implementation MUST NOT:

- modify `src-tauri/` for this feature;
- redesign or refactor `DocumentManager`, `DocumentSession`, `WorkContextManager`, canonical path identity, path reservation/ownership, Save/Save As, Rename/Delete coordination, or stale-operation generation guards;
- change `deriveFileOperationContext()` so a selected file stops resolving its parent as the creation target;
- change the shared `explorer.newFile` / `explorer.newFolder` command ids or globally disable those commands merely because a file is selected;
- introduce new global command ids, Settings, a generic context-menu framework, a panel framework, or a create/rename modal/popup;
- add React state mirroring of CodeMirror document text or selection;
- change Workspace lazy-loading/Refresh behavior to solve click semantics;
- add dependencies or test frameworks unless an existing repository capability is genuinely insufficient; ordinary 004 implementation should need no dependency changes;
- implement a WebView2 cursor workaround, Runtime downgrade/pin, or Fixed Runtime packaging as part of 004;
- opportunistically restyle unrelated Explorer/Tab/editor UI or rename/reorganize unrelated files.

If implementation appears to require one of the above, the agent MUST stop that line of change and satisfy the frozen 004 behavior through the existing architecture instead.

## Constitution Check

### Pre-design check

- **I. User Data Is Inviolable — PASS**: 004 does not change saved baselines, Save As, file encoding, dirty-state transitions, or unsaved-work guards. Inline cancellation performs no filesystem mutation, and Enter-triggered work preserves the existing disk-first reconciliation path.
- **II. State Has One Owner — PASS**: CodeMirror remains the sole owner of live document and selection state. The inline commit flag is transient DOM coordination held in a ref, not duplicated application state. Rust retains ownership of raw bytes and filesystem I/O.
- **III. Contracts Are Verified From Both Sides — PASS / NOT AFFECTED**: Frontend behavior changes receive focused Vitest and manual acceptance coverage. No Tauri IPC contract changes are allowed; the full frontend and Rust gates still run to prove the existing boundary remains synchronized.
- **IV. Commands Have One Execution Path — PASS**: Header, menu, and shortcut creation continue through their existing stable commands. Context-menu filtering changes only presentation, and the TabBar `+` continues to dispatch the canonical Untitled-document command exactly once.
- **V. Scope and Complexity Must Be Earned — PASS**: The design uses existing controllers/actions, one narrow surface predicate, a minimal promise result, local refs, and styling changes. It adds no dependency, persistent state, command id, framework, or backend subsystem.

### Post-design check

The completed design decisions and expected touch set preserve all five principles without an exception or Complexity Tracking entry. Phase 8 repeats this check against the actual diff before completion. Any implementation that changes IPC, mirrors CodeMirror state, adds a second command path, weakens disk-first behavior, or expands beyond the approved touch set fails this gate and must be corrected before handoff.

## Completion Gates

The current repository `AGENTS.md` requires the standard completion gates. Before 004 is considered complete, run:

```text
npm run typecheck
npm run test
npm run build
cargo test   # from src-tauri/
```

Even though 004 should not touch Rust, `cargo test` remains part of the repository completion gate.

## Design Decisions

### 1. Directory row selection and expansion are separate gestures

`ExplorerTree.tsx` currently toggles a directory from the row `onClick`. 004 changes only the event mapping:

```text
file row single click
→ focus row
→ select file

file row double click
→ open/activate file

directory row single click (outside chevron)
→ focus row
→ select directory
→ DO NOT toggle

directory row double click (outside chevron)
→ directory is already/also selected
→ toggle directory exactly once

chevron click
→ stop propagation
→ toggle directory
→ DO NOT change selection

chevron double-click event
→ stop propagation
→ DO NOT invoke row double-click handler
```

A physical double-click on the chevron may naturally produce two chevron click toggles; 004 does not add debounce/delay logic to reinterpret that gesture. The requirement is that the row-level double-click handler does not add an extra third toggle.

Do not move lazy-load decisions into the React component. The existing `controller.toggleDirectory()` remains the only expansion/load entry point.

### 2. File context-menu filtering is a surface rule, not a target-model change

The completed 003 `FileOperationContext` is correct:

```text
selected directory -> createParentPath = selected directory
selected file      -> createParentPath = selected file parent
root/no selection  -> createParentPath = Workspace root
```

004 preserves this exactly.

Add a narrow context-menu-specific predicate, for example:

```ts
isContextMenuCreateAvailable(context)
```

Required semantics:

```text
no Workspace                -> false
file selected               -> false
directory selected          -> existing create availability
root / blank-space context  -> existing create availability
```

`isCreateAvailable(context)` remains the shared command/header availability rule and MUST continue to return true for a valid selected-file parent context.

`ExplorerContextMenu.tsx` uses the context-menu predicate only for rendering New File/New Folder. Rename/Delete/Refresh keep the completed 003 rules.

### 3. Inline blur needs an explicit commit-attempt boundary

Do not implement unconditional `onBlur={cancelInlineEdit}`. That races an Enter-triggered async create/rename operation and can make an explicit commit look cancelled while disk work continues.

Use a small UI/action contract instead of adding a new Explorer state machine.

Recommended contract:

```ts
type InlineCommitResult = "committed" | "retained";

ExplorerActions.commitInlineEdit(): Promise<InlineCommitResult>
```

Meaning:

- `committed`: the inline edit is no longer expected to remain editable. This includes successful create/rename and existing no-op rename behavior that intentionally closes the editor.
- `retained`: no commit was completed and the current draft remains the active inline edit. This includes empty/incomplete create input and create/rename failures whose current behavior retains the draft.

The input component owns only the transient DOM commit-attempt flag:

```text
Enter keydown
→ prevent default / stop propagation
→ if commitInFlight == true: consume the repeated Enter and return
→ synchronously set commitInFlight = true
→ await onInlineCommit()
→ clear commitInFlight
→ if result == retained and this input is still mounted/current, focus it again

Escape keydown
→ if commitInFlight == false: preserve the existing explicit cancel
→ if commitInFlight == true: consume Escape and do not cancel the already-started operation

blur
→ if commitInFlight == false: cancel inline edit
→ if commitInFlight == true: ignore this blur
```

Use an input ref for refocus. A ref is appropriate because this is DOM focus coordination, not application/domain state.

Do NOT add `committing` to persisted `ExplorerState` solely for this feature unless the existing action contract proves impossible to express otherwise.

If WorkContext replacement unmounts/replaces the input while a commit is in flight, the post-await focus attempt naturally becomes a no-op; existing origin/generation guards continue to decide whether Tree reconciliation is still valid.

### 4. Preserve existing create/rename orchestration; only report the outcome

`commitCreate()` / `commitRename()` currently contain the correct disk-first/path-reservation/stale-context logic. Do not rewrite those flows.

Make only the minimum return-path changes needed so `commitInlineEdit()` can tell the input whether the draft was committed/closed or retained.

Expected mapping:

```text
Create: empty trimmed name           -> retained
Create: identity/reservation failure -> retained
Create: filesystem failure           -> retained
Create: success                      -> committed

Rename: unchanged/empty name where existing behavior closes edit -> committed
Rename: identity/reservation failure -> retained
Rename: affected-session resolution failure -> retained
Rename: filesystem failure           -> retained
Rename: success                       -> committed
```

Do not alter successful create-open behavior, successful rename document-path adoption, reservation release order, or stale-origin Tree guards.

### 5. TabBar `+` becomes the tail item of the scroll strip

Current 003 structure:

```text
.tab-bar
├─ .tab-bar__scroll [tabs...]
└─ fixed .tab-bar__new
```

004 structure:

```text
.tab-bar
└─ .tab-bar__scroll
   ├─ tabs...
   └─ .tab-bar__new
```

The `+` is therefore part of horizontal overflow and may scroll out of view.

Keep the existing active-tab `scrollIntoView()` behavior, but add a tail/new-button ref so that when the active Tab is the final Tab, scrolling reveals both the final Tab and trailing `+`. This must work when the user manually activates the final Tab and after a newly appended final Tab becomes active.

Do not reorder Tabs and do not move `+` beside whichever Tab is currently active.

### 6. CodeMirror selection fix is visual only

The current CodeMirror configuration uses `basicSetup`, whose drawn selection layer can be visually obscured by an opaque `.cm-activeLine` background. 004 corrects styling only.

Implementation requirements:

- keep `basicSetup` and CodeMirror's existing selection mechanism;
- use a selector specific enough to style CodeMirror's focused drawn selection layer reliably;
- make active-line styling non-occluding where it overlaps selection (for example by using a transparent/mixed active-line background rather than an opaque layer);
- continue to source colors from existing CSS custom properties/tokens;
- do not alter EditorState, selection transactions, history, EditorHandle, or document/session logic;
- avoid broad unrelated palette changes. If a new editor-specific token is required, add only that token; otherwise prefer composing existing tokens.

### 7. WebView2 cursor issue remains deferred

The current machine runs WebView2 Runtime `153.0.4234.32`, and the native-dialog pointer-disappearance issue is treated as an external Runtime compatibility defect for now.

004 MUST NOT add cursor CSS/JS workarounds, Runtime detection, downgrade logic, packaging changes, or Fixed Runtime bundles. Record it only as a known deferred issue outside implementation scope.

## Expected File Touch Set

Normal implementation should be limited to this set or a strict subset:

```text
src/app/explorer/ExplorerTree.tsx
src/app/explorer/Explorer.tsx
src/app/explorer/ExplorerContextMenu.tsx
src/app/explorer/explorerActions.ts
src/app/explorer/explorerActions.test.ts
src/app/tabs/TabBar.tsx
src/styles/tabs.css
src/editor/editorConfig.ts
```

`src/styles/explorer.css` may be touched only if a small focus/inline visual adjustment is actually required by the frozen behavior.

`src/styles/global.css` may be touched only if the CodeMirror selection fix genuinely requires one narrowly scoped editor styling token; otherwise it should remain unchanged.

Unexpected changes to the following are a design-drift warning and should be reverted unless directly proven necessary:

```text
src-tauri/**
src/app/document/**
src/app/workspace/**
src/services/workspaceFileService.ts
src/services/fileService.ts
package.json
package-lock.json / npm lockfile
```

## Test Strategy

### Automated tests

Use existing Vitest coverage where logic can be tested without introducing a component-test dependency:

- context-menu-specific creation predicate for root/directory/file/no-Workspace cases;
- `commitInlineEdit()` result mapping for empty create, create failure/success, rename failure/success/no-op;
- preservation of existing selected-file `createParentPath` behavior;
- preservation of existing create/rename disk-first and reservation tests.

Do not add React Testing Library/jsdom solely for 004 unless the repository already contains a suitable dependency by implementation time. Row click/double-click, blur focus behavior, TabBar position, and selection visuals can be covered by focused manual Tauri verification plus type/build gates.

### Manual Tauri verification

Use a disposable Workspace and verify:

1. unloaded directory single click selects without expanding/reading;
2. chevron click expands without selecting another node;
3. directory row double click toggles exactly once;
4. file context menu hides New items; directory/root menus keep them;
5. header New while file selected still creates beside the file;
6. partial New/Rename draft disappears on ordinary blur with no disk change;
7. Enter then native failure dialog retains the draft and returns focus;
8. Enter success is not cancelled by focus loss during the async operation;
9. zero/few/overflowing Tabs keep `+` after the last Tab, and final active Tab reveals it;
10. in the default application theme, every drawn fragment of a three-line partial selection has a non-transparent `--color-selection`-derived background; active-line overlap does not replace or cover it.

## Migration / Superseded 003 Behavior

Do not edit `specs/003-workspace-explorer/` to make history look as if 003 originally specified the new behavior.

004 supersedes exactly these interaction points:

- **SR-001 — Directory Single-Click Expansion**: 003 US3 acceptance 3 / T040 coupled directory single-click selection+toggle. 004 makes single-click selection-only and row double-click the row-level toggle gesture.
- **SR-002 — Creation Actions in a File Context Menu**: 003 US8 acceptance 3 and the creation-availability portion of FR-080 exposed New File/New Folder from a file context menu. 004 hides those two items only on the file context-menu surface. 003 FR-051 selected-file parent targeting remains valid for header creation.
- **SR-003 — Fixed TabBar New Button**: 003 FR-018 / US10 acceptance 3 / T021 kept `+` fixed outside overflow. 004 makes it the trailing item inside the scroll strip.

Inline blur behavior and CodeMirror selection visibility are refinements of previously underspecified/visual behavior rather than architecture replacements.

## Risks and Controls

### Risk: blur cancels an Enter commit

**Control**: set the DOM commit-in-flight flag synchronously in Enter keydown before awaiting the action; blur checks that flag.

### Risk: native error dialog steals focus and strands retained draft

**Control**: action returns `retained`; after the promise resolves, focus the still-mounted input through its ref.

### Risk: file-menu cleanup accidentally disables header creation

**Control**: add a context-menu-only predicate; preserve `isCreateAvailable()` and `deriveFileOperationContext()` exactly.

### Risk: directory double-click causes multiple toggles

**Control**: row single-click never toggles; row double-click toggles once; chevron events stop propagation, including double-click propagation.

### Risk: moving `+` breaks zero-tab New

**Control**: always render the `+` inside the scroll strip even when `tabs.length === 0`; keep `onNew` unchanged.

### Risk: selection fix changes editor behavior

**Control**: CSS/CodeMirror theme only; no EditorState/EditorHandle/document changes.

## Implementation Order

```text
1. Lock context-menu helper + inline result behavior in tests
2. Change directory row/chevron event mapping
3. Apply file-context menu filtering
4. Add guarded blur + commit-result/refocus flow
5. Move TabBar + into scroll strip and tail reveal logic
6. Correct CodeMirror selection/active-line visual stacking
7. Run focused manual scenarios
8. Run all repository completion gates
9. Audit diff against expected file touch set and superseded-only scope
```
