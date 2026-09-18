# Implementation Plan: Multi-Document Tabs

**Branch**: `feature-core` | **Date**: 2026-09-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-multi-document-tabs/spec.md`

## Summary

002 upgrades Sorakada's 001 single-document lifecycle into a stable multi-document model with a real Tab strip. One mounted CodeMirror editor view is reused while each `DocumentSession` retains its own `EditorState` and view/scroll snapshot. A new `DocumentManager` addresses create/open/save/close operations by stable `documentId`, owns duplicate-file/path claims, and protects asynchronous save metadata with per-document generations. Native drag/drop opens files through the same path identity and open pipeline. Rust gains a lightweight path-inspection contract for canonical comparison identity, path kind, and disk-revision metadata while existing 001 text codec behavior remains unchanged.

## Technical Context

**Language/Version**: TypeScript ~6.0.3; React 19.1; Rust 2021 edition

**Primary Dependencies**: Tauri 2 (`@tauri-apps/api`, `tauri`), CodeMirror 6 (`codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`), `@tauri-apps/plugin-dialog`

**Storage**: No persistent application storage added in 002. Live document/session state remains process memory; text files remain user-owned filesystem files.

**Testing**: Vitest 4.1 for TypeScript state/lifecycle/service tests; Rust `cargo test` for path identity and file command contracts; manual native-GUI checklist for menus, dialogs, drag/drop, window close, scroll restoration, and large-file responsiveness.

**Target Platform**: Windows 10/11 desktop first; browser-only Vite development mode must continue rendering without Tauri IPC. Architecture should remain cross-platform-friendly where practical.

**Project Type**: Tauri desktop application with React/TypeScript webview UI and Rust backend commands.

**Performance Goals**:

- One shared CodeMirror `EditorView`, regardless of Tab count.
- Ordinary editor transactions update only the owning session reference; they do not mirror full text into React state.
- React Tab/application metadata updates occur only when UI-relevant metadata changes.
- On the reference Windows development machine, a 20-cycle small → large → small benchmark produces 40 activation measurements. Measure from Tab selection to the first animation frame after the target editor state is bound and focused; each must be within 500 ms, and the median of the final 10 measurements must be no more than 25% slower than the median of the first 10.

**Constraints**:

- Preserve all 001 UTF-8/BOM/EOL behavior and successful-write baseline rules.
- Real file writes remain explicit Save/Save As only.
- No filesystem watcher, recovery, persisted session, autosave, Save All, workspace/file tree, or search subsystem in 002.
- Native GUI automation is prohibited unless explicitly requested by the user; manual validation must be handed to the user.
- Repository text files must be edited with UTF-8-safe tooling; do not use unsafe Windows PowerShell 5.1 text cmdlets.
- Before completion, `npm run typecheck`, `npm run test`, `npm run build`, and `cd src-tauri && cargo test` must all pass.

**Scale/Scope**: No artificial Tab limit. Automated correctness coverage should exercise at least 20 document sessions; manual performance coverage includes a 20–50 MB text file. Files in the hundreds of MB remain outside this milestone's explicit performance target.

## Constitution Check

The provided `.specify/memory/constitution.md` is an unfilled template and contains no active project-specific MUST/SHOULD gates. Repository-level `AGENTS.md` therefore supplies the effective development gates for this feature.

### Pre-Design Gates

- **PASS — CodeMirror remains the live text owner**: no React text mirroring is introduced.
- **PASS — Byte/BOM/EOL ownership remains in Rust**: path inspection is added beside, not inside, frontend text manipulation.
- **PASS — Successful-write invariant preserved**: only successful, still-relevant saves may advance path/baseline metadata.
- **PASS — One command route**: menu, keyboard, Tab close button, and drag/drop reuse shared manager/command paths rather than duplicating lifecycle logic.
- **PASS — Native GUI safety**: automated tests cover pure logic/IPC; native window/dialog/drop checks are documented for human verification.
- **PASS — Verification gates retained**: typecheck, Vitest, production build, and Rust tests remain mandatory.

### Post-Design Re-check

- **PASS**: `DocumentManager` centralizes lifecycle and path ownership; no competing controller is retained after migration.
- **PASS**: `DocumentSession.editorState` is process memory only and CodeMirror-owned state is not serialized/mirrored into React.
- **PASS**: new Rust path inspection does not alter the 001 text codec's raw-byte authority.
- **PASS**: deferred subsystems (watcher/recovery/session/theme UI) receive extension points, not placeholder services or speculative runtime behavior.

## Architecture

### 1. Runtime ownership

```text
React App / TabBar
    │
    │ lightweight TabSnapshot[]
    ▼
DocumentManager
    ├─ ordered DocumentSession map
    ├─ activeDocumentId
    ├─ nextUntitledNumber
    ├─ openPathIndex (comparisonKey -> documentId)
    ├─ pendingPathClaims (comparisonKey -> documentId)
    └─ lifecycle/save generations
            │
            ├──────── FileDialogService
            ├──────── FileService / Tauri invoke
            │
            ▼
      EditorHandle / Editor bridge
            │ documentId + EditorState
            ▼
       one EditorView
```

### 2. Document state boundaries

`DocumentSession` owns the latest immutable CodeMirror `EditorState` reference. The editor bridge emits every state update with the document identity currently bound to the shared view. The manager writes the reference into that session immediately. Dirty comparison is performed only when `docChanged` is true.

React does not subscribe to every state reference replacement. The manager emits a new `DocumentManagerSnapshot` only when at least one Tab-visible field changes (tab order, active id, display name/path, dirty flag, or document added/removed). This keeps typing/cursor movement out of the general React render loop.

### 3. Activation sequence

```text
activateDocument(targetId)
  current = active session
  if editor attached:
      current.viewState = editor.captureViewState()
  activeDocumentId = targetId
  target = get target session
  editor.setState(targetId, target.editorState)   // bridge binds id before setState
  editor.restoreViewState(target.viewState)
  emit TabSnapshot change
  editor.focus()
```

The editor update callback is identity-bearing, so any callback produced during a state swap is attributed to the target id, never the previous active id.

### 4. New/open flow

New creates an `EditorState` with the existing common editor extensions and allocates `UntitledN` from a process-local monotonic counter. No unsaved guard is run.

Normal Open:

```text
pick path
  -> inspect_file_path(path, allowMissing=false)
  -> if comparisonKey already owned: activate existing; stop
  -> if not regular file: report/stop
  -> read_text_file(path)
  -> create session only after read/decode succeeds
  -> register comparisonKey ownership
  -> append Tab and activate
```

This avoids rereading a large already-open file and prevents half-created Tabs on decode/read failure.

### 5. Path identity and disk revision

Add a Rust-side `inspect_file_path` command with a stable serialized DTO. It must support existing paths and a missing final component for Save As target comparison. Conceptually:

```text
PathIdentityResult
  requestedPath
  canonicalPath        // internal resolved path/candidate path
  comparisonKey        // platform comparison key
  kind                 // file | directory | missing
  diskRevision?        // size + modified-time metadata when available
```

For a missing final component, canonicalize/resolve the nearest existing parent and join the requested leaf name. On Windows, derive a case-insensitive comparison key consistently. Deduplication in 002 follows this canonical path key; distinct hard-link paths may remain separate Tabs. A native filesystem ID can be added later without changing manager ownership semantics.

### 6. Save and Save As

Saving never reads document text from “whatever is active” after async work begins. The operation captures:

- `documentId`
- document `EditorState.doc` snapshot
- destination
- format
- new per-document save generation
- target comparison key/claim when Save As is involved

Same-target disk writes continue to serialize in issue order. On completion:

```text
session = manager.getSession(documentId)
if session missing:
    release claims; ignore metadata update
if generation != session.latestSaveGeneration:
    release claims; ignore metadata update
if write failed:
    release claim; report; keep prior path/baseline/dirty
else:
    if Save As:
        inspect written target
        remove old path ownership (if any)
        adopt new path/comparisonKey/revision
        commit target claim to ownership map
    savedBaseline = captured snapshot
    dirty = !session.editorState.doc.eq(captured snapshot)
    emit metadata update if visible fields changed
```

This is deliberately conservative: if an older save succeeds but a newer intent exists, the older completion does not change the current session's path/baseline metadata.

### 7. Save As target claims

Before writing a Save As target, resolve its comparison key. Reject when the key is owned by another session or reserved by another in-flight Save As. A document may target its own current key. Reserve the key before write; release on failure/staleness; convert the claim to regular ownership only after the latest relevant Save As succeeds.

### 8. Close Tab and close window

`closeDocument(id)` operates directly on the requested document; it does not activate inactive Tabs. Dirty close reuses the existing Save / Don't Save / Cancel dialog semantics. If closing the active document succeeds, choose the left neighbor if present, otherwise the new first Tab. If normal close removes the final Tab, create the next `UntitledN`.

Window exit uses a separate `prepareCloseAll()` flow over a stable snapshot of current document ids. It prompts dirty sessions one by one and never calls the normal last-Tab replacement rule. Any cancel/save failure returns `false`; the caller leaves the window open. If all allow closure, the window lifecycle destroys the window directly.

### 9. Drag/drop

Install Tauri's native `onDragDropEvent` only inside the Tauri runtime. `enter`/`over` set a small React `isFileDragActive` UI flag; `leave`/`drop` clear it. On `drop`, process `paths` sequentially:

```text
lastSuccessfulId = null
for path of paths:
    result = await manager.openPath(path, { ignoreDirectories: true })
    if success/duplicate activation:
        lastSuccessfulId = result.documentId
    // errors are reported but do not throw out of the batch
if lastSuccessfulId:
    manager.activateDocument(lastSuccessfulId)
```

The manager/open pipeline remains the source of identity and decoding truth; drag/drop itself has no separate file-opening implementation.

### 10. Tab UI

Add a lightweight `TabBar` above the editor host. It receives only `TabSnapshot[]` and callbacks. Each Tab shows display name, dirty marker, active styling, close button, and full path via tooltip/title when available. Overflow is horizontal; the active Tab element scrolls into view on active-id change. Tab dragging/reordering, pinning, multi-row tabs, and advanced context menus are explicitly absent.

### 11. Application-level appearance extension point

Refactor `editorConfig.ts` so the current appearance extension is inserted through an application-level reconfiguration boundary (CodeMirror `Compartment` or equivalent helper). All document states are created through the same factory. 002 does not add a theme selector; it only prevents the multi-document design from treating theme as a per-document preference or requiring view recreation later.

## Project Structure

### Documentation (this feature)

```text
specs/002-multi-document-tabs/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/
│   └── requirements.md
├── contracts/
│   ├── document-manager.md
│   ├── editor-bridge.md
│   ├── file-path-identity.md
│   └── ui-behavior.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── app/
│   ├── App.tsx                         # application wiring, native surfaces, lightweight snapshot state
│   ├── commands/
│   │   ├── commandIds.ts              # add file.close
│   │   ├── commandRegistry.ts
│   │   └── ideaKeymap.ts              # add Ctrl+W
│   ├── document/
│   │   ├── documentSession.ts         # multi-document session/entity types
│   │   ├── documentManager.ts         # replaces single-document controller lifecycle ownership
│   │   └── documentManager.test.ts
│   ├── dragdrop/
│   │   ├── fileDropController.ts      # batch/drop orchestration independent of Tauri event registration
│   │   └── fileDropController.test.ts
│   ├── menu/
│   │   └── appMenu.ts                 # File > Close
│   ├── performance/
│   │   └── activationBenchmark.ts     # SC-005 Tab-activation timing marks (benchmark only)
│   ├── tabs/
│   │   └── TabBar.tsx                 # lightweight Tab UI
│   └── window/
│       ├── windowLifecycle.ts          # active title + close-all guard
│       └── windowLifecycle.test.ts
├── editor/
│   ├── Editor.tsx                     # one view, initial active state supplied by app/manager
│   ├── editorConfig.ts                # shared state factory + appearance extension point
│   └── editorHandle.ts                # identity-bearing state updates + view-state capture/restore
├── services/
│   ├── fileDialogs.ts
│   ├── fileService.ts                 # add inspectFilePath IPC wrapper
│   └── fileService.test.ts
└── styles/
    ├── global.css
    ├── editor.css
    └── tabs.css                       # Tab strip + drop overlay styling

src-tauri/
└── src/
    ├── commands/
    │   └── file.rs                    # expose inspect_file_path command + contract tests
    ├── file_codec.rs                  # existing 001 codec stays authoritative
    ├── file_identity.rs               # path resolution/comparison/revision logic + Rust tests
    └── lib.rs                         # register new command/module
```

**Structure Decision**: Preserve the existing React/Tauri split and command registry. Replace the single-document lifecycle controller rather than layering a second manager around it. Keep native path semantics in Rust; keep the one live CodeMirror view inside `src/editor/`; keep React Tab UI on lightweight projections only.

## Design Artifacts

- [research.md](research.md): Architecture and integration decisions.
- [data-model.md](data-model.md): Session, manager, identity, view-state, and operation models.
- [contracts/document-manager.md](contracts/document-manager.md): Manager behavior and result contracts.
- [contracts/editor-bridge.md](contracts/editor-bridge.md): CodeMirror/application boundary.
- [contracts/file-path-identity.md](contracts/file-path-identity.md): Proposed Tauri/Rust path inspection wire contract.
- [contracts/ui-behavior.md](contracts/ui-behavior.md): Tab/drop/window user-interface contract.
- [quickstart.md](quickstart.md): Automated and human validation guide, including the §12 SC-005 benchmark procedure and the §15 native-GUI checklist the user runs.

## Complexity Tracking

No constitution violations or unjustified architectural layers are introduced. The new manager and path identity resolver are required to enforce multi-document ownership; deferred subsystems are not scaffolded as empty services.
