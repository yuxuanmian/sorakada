# AGENTS.md

Guidance for automated agents working in this repository. Read this before making
changes — the first rule exists because breaking it has already corrupted files
in this project more than once.

## 1. Never edit text files with Windows PowerShell 5.1 cmdlets

**This is the most damaging trap in this repository.**

The `pwsh` command on this machine resolves to **Windows PowerShell 5.1**
(`$PSVersionTable.PSEdition -eq 'Desktop'`), whose ANSI codepage is `gb2312`.
`Get-Content` / `Set-Content` therefore decode a UTF-8 file with the wrong
codepage and write back mojibake — sometimes as **invalid UTF-8**.

Observed damage: `→` became `鈫?`, `—` and `–` became `鈥?` / `鈥揟`, and `⚠️` / `🎯`
became `鈿狅笍` / `馃幆`. The file can still pass a "is it valid UTF-8?" check while
being silently wrong, so the corruption is easy to miss.

> These mojibake sequences are deliberate examples. This file is the one place
> where residual CJK is expected — do not "repair" them.

### Rules

1. **Prefer the editor tools** (`edit` / `write`) for any file change. They are
   always UTF-8 safe.
2. **If a script must touch a text file, run it under PowerShell 7+.**
   On this machine: `D:\Program Files\PowerShell\7\pwsh.exe` (note: on `D:`, not
   under `C:\Program Files` — `Get-Command pwsh` finds it, hardcoded `C:` paths
   do not). PowerShell 7 is UTF-8 native and round-trips safely.
3. **Check which shell you are in first:**
   ```powershell
   $PSVersionTable.PSEdition   # 'Desktop' = 5.1 (dangerous), 'Core' = 7+
   ```
4. **If you are stuck on 5.1, be explicit about encoding** — never let the
   cmdlets guess:
   ```powershell
   $p = 'path\to\file.md'
   $t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
   # ...modify $t...
   [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
   ```
5. **Never** use bare `Set-Content`, `Out-File`, `>` or `>>` on a text file
   without an explicit encoding.

### After any scripted text edit, verify

```powershell
$bytes = [System.IO.File]::ReadAllBytes($p)
[void](New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes)  # throws if invalid
```

Then confirm the intended characters are still present and no stray CJK
ideographs appeared (residual CJK in an English document is the tell-tale sign).

## 2. Native desktop verification: ask the human, do not script window control

Sorakada has native menus, file pickers, modal prompts and a WebView2 host.
Automating those — `SendKeys`, `SendInput`, UI Automation, forcing windows to the
foreground — has repeatedly disrupted the user's desktop and sent stray
keystrokes into unrelated applications.

**Rule:** implement and verify everything that can be automated (unit tests,
`cargo test`, and CDP over the app's own IPC for the web layer). Then **hand the
native-GUI cases to the user as a concrete checklist** and wait for their report.
Do not drive windows, dialogs or keyboard input on their desktop unless they
explicitly ask you to.

Two notes that save time:

- `window.__TAURI_INTERNALS__.invoke` is defined `writable: false,
  configurable: false`, so the Tauri dialog layer **cannot** be stubbed from the
  page. Do not attempt it.
- Tauri's native menu accelerators are not translated into menu commands while
  the WebView2 has focus; the application dispatches the shortcut profile itself
  (see `src/app/App.tsx`). Do not "fix" this by adding a second shortcut route.

## 3. Verification commands

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
