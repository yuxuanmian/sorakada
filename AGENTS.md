# AGENTS.md

Guidance for automated agents working in this repository. Read this before making
changes — the first rule exists because breaking it has already corrupted files
in this project more than once.


## 1. Verification commands

All four must pass before reporting work as complete:

```bash
npm run typecheck
npm run test          # Vitest
npm run build
cd src-tauri && cargo test
```

If `npm install` fails with `EPERM` against the global npm cache, add
`--cache .npm-cache` (already gitignored).

## 4. Quick orientation

- `src/app/document/` — document lifecycle, saved baseline, dirty state, unsaved guard
- `src/app/commands/`, `src/app/menu/`, `src/app/window/` — command registry, IDEA keymap, native menu, window title/close
- `src/editor/` — CodeMirror. **CodeMirror owns the live document text**; never mirror it into React state
- `src/services/` — Tauri `invoke` wrappers and native dialog adapters
- `src-tauri/src/` — Rust owns bytes/BOM/EOL; `file_codec.rs` is the only module that touches raw bytes
- `specs/001-single-file-editing/` — spec, plan, tasks, contracts, quickstart

Rules that are easy to break: only a **successful** disk write may advance the
saved baseline or the Save As path, and `npm run test` must stay green alongside
`cargo test` — the two halves pin the same IPC wire contract from opposite sides.
