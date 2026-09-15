# Sorakada

A modern, good-looking desktop text editor aimed at programmers

> **Status: Early Development.** Only the application skeleton exists so far: a Tauri
> window rendering an embedded CodeMirror 6 editor. There is no file handling, no
> syntax highlighting and no settings yet.

## Tech stack

| Layer          | Technology            |
| -------------- | --------------------- |
| Desktop shell  | Tauri 2 (Rust)        |
| UI             | React 19 + TypeScript |
| Build tooling  | Vite                  |
| Editor core    | CodeMirror 6          |
| Package manager| npm                   |

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
npm run build       # typecheck + production frontend bundle
```
