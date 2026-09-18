# Research: Single-File Editing Lifecycle

## Decision 1: Keep byte-level file I/O and format handling in Rust

**Decision**: Implement dedicated Tauri commands for reading and writing text files. Rust reads/writes raw bytes and owns BOM/EOL handling; the frontend uses native dialogs only to obtain a path.

**Rationale**:

- Sorakada will later need character-set detection/conversion, so byte-oriented file logic needs a stable home now.
- Dedicated commands avoid coupling application behavior to the frontend filesystem plugin and its path scopes.
- Rust's standard filesystem APIs provide the exact bytes required for BOM and strict UTF-8 behavior.
- The codec can be unit-tested without the desktop UI.

**Alternatives considered**:

- `@tauri-apps/plugin-fs` directly from React: simpler for trivial UTF-8 text but makes later encoding support and byte-preserving policies harder to centralize.
- Doing decoding in TypeScript after reading bytes: duplicates native/file concerns in the WebView layer and weakens the Rust backend boundary already planned for Sorakada.

## Decision 2: Normalize editor text to LF and preserve format as metadata

**Decision**: CodeMirror receives Unicode text with LF separators only. BOM presence and detected/preferred EOL style live in document metadata.

**Rationale**:

- CodeMirror's logical document should not carry disk-format concerns.
- Cursor positions, history, dirty snapshots, and later syntax features remain independent of operating-system EOL bytes.
- Save can deliberately reproduce LF/CRLF rather than accidentally relying on WebView/platform behavior.

**Alternatives considered**:

- Preserve CRLF inside CodeMirror: spreads EOL handling through editing code and complicates line semantics.
- Preserve every Mixed line ending: requires a parallel per-line provenance structure that must survive insert/delete/move operations; disproportionate for M1.

## Decision 3: Strict UTF-8 support in M1

**Decision**: Support UTF-8 with or without UTF-8 BOM. UTF-16 BOMs, invalid UTF-8, NUL-containing input, and any CR byte outside CRLF (including one mixed with LF or CRLF) are rejected as unsupported in this feature.

**Rationale**:

- The feature spec explicitly limits encoding support to UTF-8/UTF-8 BOM.
- Strict failure is safer than opening undecodable bytes as replacement characters and later corrupting the file on save.
- Recognizing UTF-16 BOMs allows a specific unsupported-encoding error without pretending the file is UTF-8.
- NUL is a conservative binary-file signal for the intended programmer-text use case.
- A CR byte outside CRLF is outside the LF/CRLF contract and is safer to reject than to treat ambiguously, even when other supported line endings occur in the same file.

**Alternatives considered**:

- Automatic legacy-encoding detection: deferred because byte sequences are often ambiguous and the spec explicitly excludes it.
- Lossy UTF-8 decoding: rejected because it can silently destroy original bytes.

## Decision 4: Track dirty state with CodeMirror `Text` snapshots

**Decision**: Retain the last successfully saved CodeMirror `Text` object as the saved baseline and compare using `Text.eq` after document changes.

**Rationale**:

- CodeMirror `Text` is immutable and tree-structured.
- `Text.eq` is efficient when documents share structure and correctly detects Undo back to saved contents.
- It avoids mirroring full text strings into React state on every keystroke.

**Alternatives considered**:

- Boolean "changed once" flag: cannot return to clean after Undo.
- Stringify and hash/compare every edit: unnecessary full-buffer work and duplicate text allocation.
- Store the entire document in React state: violates the existing editor ownership boundary and would add avoidable rerenders.

## Decision 5: Use snapshot semantics for asynchronous Save

**Decision**: Capture the exact CodeMirror `Text` object being saved before invoking Rust. On success that snapshot—not whatever happens to be current afterward—becomes the saved baseline.

**Rationale**:

- Correctly handles users typing while a save is in flight.
- A successful write can never falsely mark newer edits clean.

**Alternatives considered**:

- Set `dirty=false` after every successful write: incorrect under concurrent user edits.
- Temporarily lock the editor during save: poorer UX and unnecessary for an ordinary text file workflow.

## Decision 6: Use Tauri native dialog plugin for file pickers, errors, and unsaved prompt

**Decision**: Add `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog`. Use `open()` and `save()` for path selection, `message()` for error messages, and a three-button `Yes/No/Cancel` message with custom labels Save / Don't Save / Cancel for unsaved work.

**Rationale**:

- M1 intentionally avoids a UI framework.
- Current Tauri 2 dialog APIs support desktop filesystem paths and three-button custom message labels.
- Native dialogs match the desktop-app direction and are sufficient until Sorakada has its own overlay design system.

**Alternatives considered**:

- React custom modal: creates UI/focus/accessibility work that was explicitly deferred.
- Multiple two-button dialogs chained together: awkward and less direct than the available native three-button API.

## Decision 7: Use frontend-created native menu with shared command IDs

**Decision**: Build native File/Edit menus with Tauri's JavaScript menu API. Each menu action dispatches a stable `CommandId`; accelerators are populated from the IDEA keymap profile.

**Rationale**:

- The command registry, menu actions, and shortcut profile all live where the active document/editor controller already exists.
- Tauri's menu API supports native multi-level menus and accelerator changes.
- `core:default` already includes core menu permissions in the current capability model.

**Alternatives considered**:

- Build the menu in Rust and emit events back to React: adds an extra event bridge for commands that are primarily frontend orchestration.
- Custom HTML menu bar: intentionally deferred until Workbench/UI design begins.

## Decision 8: Native menu accelerators are the only M1 shortcut dispatcher

**Decision**: Do not add a second global `keydown` listener for the six shortcuts implemented in this feature. Native menu accelerators invoke the same menu action → command registry path.

**Rationale**:

- Directly addresses the duplicate-execution requirement.
- Keeps M1 small while still representing keybindings as profile data.
- Menu accelerators can later be changed when custom keymap infrastructure is introduced.

**Alternatives considered**:

- Window capture `keydown` plus native accelerators: can fire the same command through two mechanisms.
- CodeMirror-only keymaps: inappropriate for application-level New/Open/Save commands.

## Decision 9: Intercept native window close in the frontend

**Decision**: Register Tauri `onCloseRequested`. Clean documents close normally. Dirty documents immediately prevent the native close, run the shared Exit/unsaved guard, and call forced `destroy()` only after approval.

**Rationale**:

- Reuses exactly the same lifecycle policy as File → Exit.
- Tauri exposes explicit close interception and a forced destroy path to avoid recursive close-request loops.

**Alternatives considered**:

- Rust-only close interception: would need to query/synchronize dirty state across the frontend/backend boundary.
- Ignore window chrome close: violates the unsaved-work requirement.

## Decision 10: Direct whole-file writes in M1; atomic replace is deferred

**Decision**: Use ordinary whole-file writes for this feature. Do not add temporary-file/atomic-replace machinery yet.

**Rationale**:

- The accepted M1 test environment uses isolated ordinary files and excludes concurrent/external modification.
- Cross-platform atomic replacement, especially replacing an existing Windows file while preserving metadata, deserves a separate explicit design rather than incidental complexity here.
- Save failure is still surfaced and never advances the in-memory saved baseline.

**Alternatives considered**:

- Temp file + atomic replacement now: stronger crash resilience but expands platform-specific semantics beyond the current spec.

## Decision 11: Add focused automated tests without full desktop UI automation

**Decision**: Use Rust unit tests for codec byte behavior and Vitest for pure TypeScript session/command logic; retain manual Tauri acceptance checks for OS-native dialogs/menu/close behavior.

**Rationale**:

- File format logic is deterministic and high-value to automate.
- Native Windows menu/dialog automation would add a large testing stack unrelated to M1's core code.
- The existing repository already relies on typecheck/build checks, so a small unit-test layer is proportionate.

**Alternatives considered**:

- Manual testing only: too weak for BOM/EOL and save-snapshot edge cases.
- Full end-to-end desktop automation: deferred until the app has a larger stable UI surface.

## References

- Tauri 2 Dialog plugin and JavaScript API: https://v2.tauri.app/plugin/dialog/ and https://v2.tauri.app/reference/javascript/dialog/
- Tauri 2 Window Menu: https://v2.tauri.app/learn/window-menu/
- Tauri 2 Window close API: https://v2.tauri.app/reference/javascript/api/namespacewindow/
- Tauri 2 core/capability permissions: https://v2.tauri.app/reference/acl/core-permissions/
- CodeMirror 6 reference: https://codemirror.net/docs/ref/
- CodeMirror `Text.eq` implementation/reference: https://github.com/codemirror/state/blob/main/src/text.ts
