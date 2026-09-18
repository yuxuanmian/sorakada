# Quickstart Validation: Single-File Editing Lifecycle

This guide validates the M1 feature end-to-end using isolated local files. Do not modify test files from another program while Sorakada has them open.

## Prerequisites

- Windows 10 or Windows 11
- Node.js 20.19+ (or 22.12+) and npm
- Rust stable with `x86_64-pc-windows-msvc`
- Visual Studio C++ desktop build tools
- WebView2 runtime

Install project dependencies after implementation changes:

```bash
npm install
```

## Automated checks

From repository root:

```bash
npm run typecheck
npm run test
npm run build
```

From `src-tauri/`:

```bash
cargo test
```

Expected: all TypeScript, frontend unit, Rust codec, and production-build checks pass.

## Launch

```bash
npm run tauri dev
```

Use only the native desktop window for this validation; browser-only `npm run dev` cannot exercise Tauri file/menu/dialog APIs.

## Fixture preparation

Prepare a temporary folder with these isolated files:

```text
utf8-lf.txt             UTF-8, no BOM, LF
utf8-crlf.txt           UTF-8, no BOM, CRLF
utf8bom-lf.txt          UTF-8 BOM, LF
utf8bom-crlf.txt        UTF-8 BOM, CRLF
mixed.txt               both LF and CRLF (one style dominant)
mixed-tie.txt           equal LF and CRLF counts
no-final-newline.txt    supported UTF-8, no terminal line break
single-line.txt         one line, no line ending
empty.txt               zero bytes
bom-empty.txt           UTF-8 BOM only
unsupported.bin         contains a NUL byte or invalid UTF-8
standalone-cr.txt       UTF-8 text with standalone CR line endings
```

For byte-sensitive checks, use a hex viewer or a small external script *after Sorakada closes the file* to confirm BOM/EOL bytes.

## Scenario A — uniform round-trip

Repeat for the four combinations UTF-8/UTF-8 BOM × LF/CRLF:

1. Open fixture with File → Open and again in a separate run with `Ctrl+O`.
2. Confirm title shows the filename and no dirty marker.
3. Edit visible text; confirm title gains `*`.
4. Save with File → Save / `Ctrl+S`.
5. Confirm dirty marker clears.
6. Close/reopen and confirm edit persisted.
7. Inspect bytes and confirm original BOM presence and uniform EOL style are preserved.

Expected: all four combinations pass with no unintended text normalization.

## Scenario B — clean Save is a no-op

1. Copy a supported uniform fixture and record its bytes/hash.
2. Open it and immediately Save without editing.
3. Close Sorakada and compare bytes/hash.

Expected: byte-for-byte unchanged.

Repeat with `mixed.txt`.

Expected: Mixed file also remains byte-for-byte unchanged when no edit occurred.

## Scenario C — Mixed edited save

1. Open `mixed.txt`.
2. Confirm it opens clean.
3. Make one text edit and save.
4. Inspect line endings.

Expected: all line endings are normalized to the style that was dominant in the original file.

Repeat with `mixed-tie.txt`.

Expected: saved result uses CRLF.

## Scenario D — New and Save As

1. Invoke New with `Ctrl+N`.
2. Confirm title is `Untitled - Sorakada` and clean.
3. Type two lines; confirm dirty.
4. Press `Ctrl+S`.
5. Choose a destination in the native Save dialog.
6. Confirm title changes to the new filename and dirty clears.
7. Inspect file bytes.

Expected: UTF-8 without BOM, CRLF line endings.

Then edit again and invoke Save As to a second path.

Expected: second file receives the captured contents; active document path/title changes only after successful write.

Cancel a Save As.

Expected: path/title/format/dirty remain unchanged.

## Scenario E — dirty and Undo baseline

1. Open a clean file.
2. Type one character; confirm dirty marker appears.
3. Invoke Undo with `Ctrl+Z`.

Expected: when content exactly matches saved baseline, dirty marker disappears.

4. Invoke Redo with `Ctrl+Shift+Z`.

Expected: edit returns and document is dirty again.

## Scenario F — unsaved protection

For each destructive action New, Open, and window/Menu Exit:

1. Start from a dirty document.
2. Trigger the action; for Open, choose a valid target file before the unsaved-work prompt appears.
3. Test Cancel.
4. Test Don't Save.
5. Test Save.

Expected:

- Cancel keeps current document exactly as-is.
- Don't Save performs requested destructive action.
- Save performs action only after successful save.
- Cancelling the nested Save As for an untitled document keeps the original dirty document open.
- Cancelling Open's file picker leaves the dirty document unchanged without showing the unsaved-work prompt.

## Scenario G — unsupported open

1. Open a valid file and make a recognizable edit without saving.
2. Attempt to Open `unsupported.bin`.

Expected: native error is shown; current path, text, format, and dirty state do not change.

Repeat with `standalone-cr.txt`. Expected: an unsupported line-ending error is shown with the same unchanged state. Neither failed Open shows the unsaved-work prompt.

## Scenario H — final newline and whitespace preservation

1. Open `no-final-newline.txt`.
2. Edit text that is not at EOF and save.
3. Inspect bytes.

Expected: no final newline was added.

Repeat with trailing spaces in a line.

Expected: trailing spaces remain untouched.

## Scenario I — edit while Save is in flight

This is primarily covered by a unit/integration test using a controllable delayed/mock file-service promise:

1. Snapshot content A and begin Save.
2. Before mocked write resolves, edit to content B.
3. Resolve Save of A successfully.

Expected: saved baseline becomes A but current B remains dirty.

A manual filesystem save may complete too quickly to reproduce reliably and is not required for manual acceptance.

## Scenario J — menu/shortcut single dispatch

For each required shortcut:

```text
Ctrl+N
Ctrl+O
Ctrl+S
Ctrl+Shift+S
Ctrl+Z
Ctrl+Shift+Z
```

Invoke it once and verify only one dialog/action/change occurs. Then invoke the matching menu item and verify equivalent behavior.

Expected: no doubled Save dialog, duplicate New/Open flow, or double Undo/Redo.

Invoke Exit once from the menu and once in a separate run through the window close control. Both use the same unsaved-work guard; Exit has no M1 shortcut.

## Completion criteria

The feature is ready for task completion when:

- all automated checks pass
- all spec acceptance scenarios have a matching passing validation above
- the four uniform BOM/EOL round-trip combinations pass
- Mixed/no-EOL/error/dirty-close edge cases pass
- no advanced UI, tabs, external-change detection, or legacy-encoding behavior was introduced incidentally
