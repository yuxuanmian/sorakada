# Sorakada

A modern, good-looking desktop text editor aimed at programmers

> **Status: Early Development.** Six milestones are implemented: single-file editing
> (M1), multi-document tabs (M2), the Workspace Explorer (M3), interaction polish
> (M4), opened-document external-change detection (M5) and Workspace filesystem
> synchronization (M6). There is still no syntax highlighting, search/replace,
> settings, multi-root Workspace or Git integration, and only UTF-8 (with or
> without BOM) can be opened.

## Workspace filesystem synchronization (M6)

The Explorer follows structural changes made outside Sorakada without ever turning
into a recursive crawler:

- **Structure converges from disk, not from events.** Watcher notifications are
  hints only; the authoritative answer is a fresh one-level read of a directory
  the Tree already represents. A never-opened directory is never read merely
  because events happened below it.
- **Confirmed rename/move continuity.** A rename or move preserves the Tree node
  (cached subtree and expansion included) and rebinds open documents only when the
  source and destination can be *proven* to be the same filesystem object — a
  stable volume + file-index identity on Windows. Without that proof the result
  degrades to remove + create, and M5's missing/conflict rules stay authoritative
  for the document.
- **Bounded under event storms.** Hints coalesce per represented directory,
  recovery covers only the root plus currently expanded directories, and a
  low-frequency periodic pass (plus focus regain and Manual Refresh) provides
  eventual consistency. A collapsed `node_modules` with hundreds of thousands of
  descendants is never enumerated.
- **Internal operations stay safe.** Rename/Delete re-verify the selected entry
  immediately before touching the filesystem, so an externally replaced object is
  never renamed or trashed.

The behavioral contract is `specs/006-workspace-filesystem-sync/spec.md`, the
design is `plan.md`, and the task list plus verification evidence (including the
manual acceptance matrix) is `tasks.md` in the same directory.

## Tech stack

| Layer          | Technology            |
| -------------- | --------------------- |
| Desktop shell  | Tauri 2 (Rust)        |
| UI             | React 19 + TypeScript |
| Build tooling  | Vite                  |
| Editor core    | CodeMirror 6          |
| Tests          | Vitest, `cargo test`  |
| Package manager| npm                   |

## File handling (M1)

Files are decoded and encoded in Rust; the editor only ever sees text.

- **Encodings:** UTF-8 and UTF-8 with BOM. UTF-16, invalid UTF-8, NUL-containing
  (binary) input and lone `CR` line endings are rejected with a native error.
- **Line endings:** LF and CRLF are detected per file. The editor always works on
  LF-normalized text, and the detected style is re-applied on save. A file with
  both styles is reported as Mixed and is written back using whichever style was
  dominant (ties go to CRLF).
- **Lossless elsewhere:** BOM presence, trailing whitespace and the presence or
  absence of a final newline are preserved exactly. Saving a clean, unmodified
  document does not rewrite the file at all.
- **Unsaved work:** New, Open and Exit ask Save / Don't Save / Cancel before
  discarding changes; closing the window does the same. Unsaved documents are
  marked with `*` in the window title.

## Shortcuts

| Shortcut        | Action     |
| --------------- | ---------- |
| `Ctrl+N`        | New        |
| `Ctrl+O`        | Open       |
| `Ctrl+S`        | Save       |
| `Ctrl+Shift+S`  | Save As    |
| `Ctrl+Z`        | Undo       |
| `Ctrl+Shift+Z`  | Redo       |

Exit has no shortcut; it is available from the File menu and the window close
control. Shortcuts are listed beside their menu items and are handled by the
application itself, so they apply while the editor window has focus.

## Requirements

- Node.js 20.19+ (or 22.12+) and npm
- Rust (stable) with the `x86_64-pc-windows-msvc` target
- Visual Studio Build Tools with the "Desktop development with C++" workload
- WebView2 runtime (preinstalled on Windows 10/11)

## Development

```bash
npm install
npm run tauri dev
```

`npm run dev` starts the Vite dev server on its own (browser-only preview, no Tauri APIs).

## Build

```bash
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/` (executable) and
`src-tauri/target/release/bundle/` (installers).

## Checks

```bash
npm run typecheck   # TypeScript, no emit
npm run test        # Vitest: document lifecycle, commands, window behaviour
npm run build       # typecheck + production frontend bundle
cargo test          # Rust: byte-level file codec (run in src-tauri/)
```

Native dialogs, menus, accelerators and close interception are validated manually;
the end-to-end acceptance matrix lives in
`specs/001-single-file-editing/quickstart.md`. Workspace synchronization (M6) is
covered by the deterministic suites above plus the manual matrix recorded in
`specs/006-workspace-filesystem-sync/tasks.md`.

