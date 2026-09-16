# Sorakada

A modern, good-looking desktop text editor aimed at programmers

> **Status: Early Development.** The single-file editing lifecycle (milestone M1) is
> implemented: open, edit, save, save a copy, unsaved-work protection and a native
> File/Edit menu with IDEA-style shortcuts. There is still no syntax highlighting,
> tabs, workspace, search/replace or settings, and only UTF-8 (with or without BOM)
> can be opened.

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
`specs/001-single-file-editing/quickstart.md`.

