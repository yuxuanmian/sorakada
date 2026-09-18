# Implementation Plan: Single-File Editing Lifecycle

**Branch**: `001-single-file-editing` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-single-file-editing/spec.md`

## Summary

Implement Sorakada's first complete single-file editing lifecycle on top of the existing Tauri 2 + React + CodeMirror 6 skeleton. The frontend will own document/session orchestration and command dispatch, CodeMirror will remain the sole owner of the live logical document, and Rust commands will own byte-level file decoding/encoding and disk I/O. Files are normalized to Unicode text with LF inside the editor, while UTF-8 BOM presence and LF/CRLF format metadata are retained for round-trip saves. Native Tauri dialogs and native File/Edit menus provide the minimum desktop UI; menu accelerators are sourced from an IDEA-style keymap profile and dispatch through the same application command registry as menu clicks.

## Technical Context

**Language/Version**: TypeScript `~6.0.3`, React `19.1.x`, Rust 2021 edition on stable toolchain; Node.js `20.19+` or `22.12+`

**Primary Dependencies**: Tauri 2, `@tauri-apps/api` 2, CodeMirror 6, `@codemirror/state`, `@codemirror/view`; add `@codemirror/commands`, `@tauri-apps/plugin-dialog`, Rust `tauri-plugin-dialog`, and `serde` derive support for command contracts

**Storage**: Local filesystem only; no database or persistent application state in this feature

**Testing**: Existing `npm run typecheck` and `npm run build`; Rust `cargo test` for file codec behavior; add Vitest for pure TypeScript document/command lifecycle logic; manual Tauri desktop validation for native dialogs, menus, accelerators, and close interception

**Target Platform**: Windows 10/11 desktop via Tauri/WebView2. Architecture remains portable where practical, but release defaults are Windows-oriented (CRLF for new documents and EOL ties)

**Project Type**: Desktop application with React frontend and Rust/Tauri backend

**Performance Goals**: Ordinary text files should open/save without perceptible application stalls in the intended M1 test set; document changes must not mirror the full text into React state; dirty checks should compare CodeMirror `Text` snapshots rather than stringify on every edit

**Constraints**: Exactly one active document; UTF-8/UTF-8 BOM only; LF/CRLF/Mixed compatibility; whole-file read/write; no external-change detection; no large-file mode; no custom UI framework; no multi-tab/workspace behavior

**Scale/Scope**: One active document, seven user commands (New/Open/Save/Save As/Exit/Undo/Redo), six defined shortcuts, four uniform BOM/EOL round-trip combinations plus Mixed/no-EOL cases

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The uploaded `.specify/memory/constitution.md` is an unfilled template and contains no ratified Sorakada-specific principles, constraints, or governance gates. There are therefore no enforceable constitution violations for this plan.

**Pre-design gate**: PASS (provisional; no project-specific constitution is currently defined).

**Post-design re-check**: PASS. The design stays within the feature spec, preserves existing layer ownership, avoids speculative UI/workspace systems, and introduces only dependencies directly required by the feature.

## Project Structure

### Documentation (this feature)

```text
specs/001-single-file-editing/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── application-commands.md
│   └── file-commands.md
└── tasks.md                 # generated later by speckit-tasks
```

### Source Code (repository root)

```text
src/
├── app/
│   ├── App.tsx
│   ├── commands/
│   │   ├── commandIds.ts
│   │   ├── commandRegistry.ts
│   │   └── ideaKeymap.ts
│   ├── document/
│   │   ├── documentController.ts
│   │   └── documentSession.ts
│   ├── menu/
│   │   └── appMenu.ts
│   └── window/
│       └── windowLifecycle.ts
├── editor/
│   ├── Editor.tsx
│   ├── editorConfig.ts
│   └── editorHandle.ts
├── services/
│   ├── fileDialogs.ts
│   └── fileService.ts
└── styles/
    ├── editor.css
    └── global.css

src-tauri/
├── capabilities/
│   └── default.json
├── src/
│   ├── commands/
│   │   ├── mod.rs
│   │   └── file.rs
│   ├── file_codec.rs
│   ├── lib.rs
│   └── main.rs
└── Cargo.toml
```

Tests remain close to the logic they validate:

```text
src/app/**/*.test.ts            # pure TypeScript/Vitest lifecycle tests
src-tauri/src/file_codec.rs     # Rust #[cfg(test)] codec tests
```

**Structure Decision**: Keep the current two-layer desktop architecture rather than introducing additional packages. React/Tauri orchestration belongs under `src/app`, CodeMirror-specific capabilities remain under `src/editor`, native file format handling lives in Rust, and Tauri invoke wrappers are separated from codec logic so the codec can be unit-tested without a running desktop shell.

## Design Overview

### 1. Live document ownership

CodeMirror remains the only owner of the live logical text. React stores only session metadata and small derived state such as `dirty`, path, filename, and text format. The editor exposes an imperative `EditorHandle` for operations that application commands need:

- retrieve the current immutable CodeMirror `Text`
- load/reset a document using a new `EditorState`
- run Undo/Redo
- focus the editor
- notify the document controller when `docChanged` occurs

Opening or creating a document resets the editor state so undo history from the previous document does not leak into the new document.

### 2. Saved baseline and dirty state

`DocumentController` stores the last successfully saved CodeMirror `Text` snapshot outside React render state. On every CodeMirror document update, dirty state is computed with `currentDoc.eq(savedBaseline)`.

Save uses snapshot semantics:

1. capture `savingSnapshot = editor.getDocument()`
2. serialize that snapshot once for the Rust write command
3. await the disk write
4. on success, set `savedBaseline = savingSnapshot`
5. recompute dirty against the editor's *current* document

This preserves `dirty = true` when the user edits again while an earlier snapshot is being written.

### 3. File read and decode

Rust `read_text_file` reads raw bytes and performs byte-level detection before returning text:

1. detect UTF-8 BOM (`EF BB BF`); explicitly identify UTF-16 BOMs as unsupported
2. reject obvious binary input containing NUL bytes
3. decode the remaining bytes as strict UTF-8
4. detect/count CRLF and standalone LF line endings
5. reject any CR byte outside CRLF in M1 rather than silently reinterpret it
6. determine detected line-ending type and preferred output style
7. normalize CRLF to LF for the text returned to CodeMirror

Line-ending metadata uses:

- `none`: no line-ending bytes exist
- `lf`: only LF
- `crlf`: only CRLF
- `mixed`: both LF and CRLF

For `mixed`, preferred output is whichever style occurs most often; ties resolve to CRLF. For `none`, preferred output is CRLF.

### 4. File write and encode

Rust `write_text_file` accepts normalized LF text and an explicit output format. The write contract only accepts target `lf` or `crlf`, never `mixed` or `none`.

Writing performs:

1. convert logical LF separators to the requested output separator
2. prepend UTF-8 BOM only when requested
3. write resulting bytes to the requested path

No trimming, Unicode normalization, or final-newline insertion/removal is performed.

A normal Save of a clean same-path document is a frontend no-op. This is important for clean Mixed documents because Sorakada does not retain per-line EOL provenance and therefore must not rewrite/normalize an unedited Mixed file. Save As always writes a newly encoded file using the document's preferred output EOL.

### 5. Document lifecycle orchestration

`DocumentController` owns New/Open/Save/Save As workflows and all state transitions.

- **New**: run unsaved guard; reset editor to empty; create untitled session with UTF-8/no-BOM and preferred CRLF; baseline is empty document
- **Open**: choose a path and call `read_text_file` first; cancellation or read/decode failure leaves the current document untouched and does not trigger the unsaved guard. After successful decode, run the unsaved guard; only if it allows replacement, install the already decoded document and establish its baseline
- **Save**: if no path, delegate to Save As; if clean and same-path, return success without disk rewrite; otherwise save a captured snapshot using existing path/format
- **Save As**: choose path; save a captured snapshot; only after success update active path and baseline
- **Exit**: run unsaved guard; if accepted, destroy the main window to avoid recursively triggering close interception

Open picker cancellation and read/decode errors leave the current session untouched, including its dirty state. A successful Save chosen in the unsaved guard may update the current session before a validated Open target replaces it. Save As cancellation and errors leave the current session untouched except for user-visible error reporting.

### 6. Unsaved-change guard

A reusable guard wraps all destructive operations (New, Open, Exit). For a dirty document it shows a native three-button message dialog:

- Save
- Don't Save
- Cancel

`Save` proceeds only when saving succeeds; cancelled/failed saving aborts the destructive action. `Don't Save` proceeds immediately. `Cancel` aborts.

### 7. Native window close interception

Register `onCloseRequested` on the main Tauri window. If the document is clean, allow the native close to proceed. If dirty, call `preventDefault()` before awaiting UI, execute the same Exit command/unsaved guard used by the menu, then call `destroy()` only after the guard succeeds.

The capability file therefore adds the minimum non-default core permissions required by the frontend window API:

- `core:window:allow-set-title`
- `core:window:allow-destroy`

The dialog plugin capability adds `dialog:default`.

### 8. Commands, menu, and keymap

Application behavior is addressed by stable command IDs rather than by menu/button functions. The M1 registry contains:

- `file.new`
- `file.open`
- `file.save`
- `file.saveAs`
- `app.exit`
- `editor.undo`
- `editor.redo`

The IDEA-style profile is data mapping command IDs to native menu accelerators. The native File/Edit menu is created in the frontend using Tauri's menu API; every menu item's `action` calls `executeCommand(commandId)`.

For M1, native menu accelerators are the sole application shortcut dispatch mechanism for these menu-exposed commands. Do not also add a parallel global DOM `keydown` listener for the same bindings. This avoids duplicate command execution and keeps menu clicks and accelerators on one command path. Later custom keymap work may replace/extend this dispatcher without changing command IDs or handlers.

M1 profile:

- `Ctrl+N` → `file.new`
- `Ctrl+O` → `file.open`
- `Ctrl+S` → `file.save`
- `Ctrl+Shift+S` → `file.saveAs`
- `Ctrl+Z` → `editor.undo`
- `Ctrl+Shift+Z` → `editor.redo`

Undo/Redo handlers call CodeMirror's command functions against the active `EditorView`; add `@codemirror/commands` as a direct dependency rather than relying on it transitively through the `codemirror` bundle.

### 9. Window title feedback

Whenever path/filename or dirty state changes, update the native window title:

- `Untitled - Sorakada`
- `foo.txt - Sorakada`
- `*foo.txt - Sorakada`

No status bar or custom workbench UI is introduced in M1.

## Phase 0: Research Output

Research decisions and alternatives are documented in [research.md](./research.md). There are no unresolved `NEEDS CLARIFICATION` items.

## Phase 1: Design Output

- Data/state model: [data-model.md](./data-model.md)
- Tauri file IPC contract: [contracts/file-commands.md](./contracts/file-commands.md)
- Application command/keymap contract: [contracts/application-commands.md](./contracts/application-commands.md)
- End-to-end validation guide: [quickstart.md](./quickstart.md)

## Implementation Sequence

1. **Rust file codec foundation** — define serializable format/error models, read/decode, EOL analysis/normalization, encode/write, and Rust unit tests.
2. **Tauri integration** — register file invoke commands, initialize dialog plugin, add required permissions/dependencies.
3. **Editor application interface** — expose active CodeMirror document, state reset, document-change notification, Undo/Redo.
4. **Document session/controller** — implement saved baseline, dirty tracking, New/Open/Save/Save As snapshot semantics.
5. **Native dialogs and unsaved guard** — implement open/save path pickers, three-button guard, error reporting.
6. **Window lifecycle** — title synchronization and dirty-aware close interception.
7. **Command/keymap/menu** — register stable command IDs, IDEA profile, native File/Edit menus, and accelerators with single-dispatch behavior.
8. **Validation** — TypeScript/Rust unit checks plus complete manual acceptance matrix from `quickstart.md`.

The later `speckit-tasks` phase should decompose these steps into independently executable coding tasks and tests; this plan intentionally stops before task-level assignments.

## Complexity Tracking

No constitution violations or complexity exceptions are required.
