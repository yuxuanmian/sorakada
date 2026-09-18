# Quickstart Validation: Multi-Document Tabs

**Feature**: `002-multi-document-tabs`  
**Target**: `feature-core`

This guide validates 002 after implementation. Automated commands should be run first. Native GUI cases are performed manually; do not script desktop window control.

## 1. Prerequisites

- Windows 10/11 development machine with the existing Sorakada toolchain.
- Node dependencies installed.
- Rust/Tauri toolchain available.
- Test fixture files:
  - `small-a.txt` (~10 KB, UTF-8)
  - `small-b.txt` (~10 KB, UTF-8)
  - `large.txt` between 20 and 50 MB, UTF-8
  - `utf8bom-crlf.txt`
  - one unsupported/binary file containing a NUL byte
  - one directory to include in a drag/drop batch

Do not automate native file pickers, message dialogs, drag/drop, or window focus with OS input injection.

## 2. Automated verification

From repository root:

```bash
npm run typecheck
npm run test
npm run build
cd src-tauri && cargo test
```

Expected: all four commands pass. Existing 001 file codec/IPC tests remain green.

## 3. Automated behavior scenarios expected in Vitest/Rust tests

Verify the test suite includes and passes cases for:

1. `Untitled1`, `Untitled2`, ... allocation is monotonic and names are not reused.
2. Editor update callback changes only the session identified by the callback document id.
3. Dirty state toggles when a document changes and can return clean when its state equals the saved baseline.
4. Inactive document Save uses its own `editorState.doc` and format.
5. Delayed Save for A completes after B becomes active without mutating B.
6. Save As X followed by Save As Y cannot let stale X completion replace Y path/baseline metadata.
7. Same-target writes remain issue-ordered.
8. Save As rejects another session's owned or in-flight claimed target.
9. Closing inactive dirty document does not activate it and Cancel preserves the current active id.
10. Closing active Tab selects left neighbor; closing first selects new first.
11. Normal close of last Tab creates next `UntitledN`.
12. `prepareCloseAll()` never creates a replacement Tab and stops on Cancel/save failure. For three dirty documents, exercise all eight Save/Don't Save completion sequences and all 14 Cancel/Save-failure abort sequences after every allowed Save/Don't Save prefix; earlier successful saves remain effective.
13. Duplicate comparison key activates existing session before reading the file again. A 20-request test alternating dialog and dropped-path orchestration keeps exactly one session for that comparison key and activates it after each request.
14. Failed open creates no session.
15. Dropped batch continues after failure and preserves input order.
16. Rust `inspect_file_path` identifies file/directory/missing candidate, emits camelCase DTO, and produces stable comparison keys for equivalent paths supported by the platform.

## 4. Manual Scenario A — Basic Tabs and independent state

1. Launch Sorakada.
2. Confirm initial Tab is `Untitled1`.
3. Type distinctive content and create some undo history.
4. `Ctrl+N`; verify `Untitled2` appears and `Untitled1` remains.
5. Type different content in `Untitled2`, move cursor, and scroll.
6. Switch repeatedly between Tabs.

Expected:

- content never crosses Tabs
- cursor/selection/history are independent
- scroll/read position is restored
- `Ctrl+Z` affects only the active document
- window title follows active document

## 5. Manual Scenario B — Untitled numbering

1. With `Untitled1`, create `Untitled2`.
2. Save `Untitled1` as `a.txt`.
3. Close `a.txt`.
4. Create another new document.

Expected: new document is `Untitled3`, not `Untitled1`.

## 6. Manual Scenario C — Open and duplicate reuse

1. Open `small-a.txt`.
2. Open `small-b.txt`.
3. Reopen `small-a.txt` 20 times, alternating File > Open and native drag/drop (10 requests through each surface). Use an equivalent spelling or a link resolving to the same canonical path for some requests if practical; distinct hard-link paths are outside 002's deduplication guarantee.

Expected:

- only one Tab represents `small-a.txt`
- every repeated request activates it without creating another session
- existing dirty Tabs were never prompted merely because another file opened

If an equivalent spelling or resolving link was available, record which requests used it.

## 7. Manual Scenario D — Save and Save As collision

1. Keep `small-a.txt` open.
2. Create `UntitledN`, type content.
3. Save As and choose the already-open `small-a.txt` target.

Expected:

- Sorakada rejects the cross-document target
- `UntitledN` stays open and dirty
- `small-a.txt` session is unchanged

Then Save As to a unique target and verify the Tab adopts the new filename only after successful write.

## 8. Manual Scenario E — Dirty Tab close

Exercise Save, Don't Save, and Cancel on a dirty Tab.

Expected:

- Save: writes and closes only after success
- Don't Save: closes without write
- Cancel: leaves Tab and active state unchanged
- closing an inactive Tab does not visually activate it just to prompt/save

## 9. Manual Scenario F — Last Tab and application exit

1. Close the only clean Tab.
2. Confirm next `UntitledN` is created.
3. Create at least three dirty Tabs.
4. Close the window and respond to prompts sequentially.
5. On a later prompt, choose Cancel.

Expected:

- window remains open
- earlier saves remain saved
- no extra replacement Untitled was created by the failed exit

Repeat and approve all prompts; expected window closes directly.

## 10. Manual Scenario G — Drag/drop

Drop a batch in this order:

```text
small-a.txt
<unsupported binary>
<directory>
small-b.txt
```

Expected:

- drag-over affordance appears and clears on leave/drop
- valid files open in supplied order
- binary failure is reported but does not stop `small-b.txt`
- directory is ignored
- already-open duplicate reuses its existing Tab
- last successful/activated document is active after batch

## 11. Manual Scenario H — Tab overflow

1. Create/open enough Tabs to exceed the window width.
2. Activate Tabs at both ends of the list.

Expected:

- editor area is not pushed beyond the window
- Tab strip is horizontally navigable
- active Tab is brought into view
- closing Tabs preserves deterministic neighbor activation

## 12. Manual Scenario I — Large-file switching benchmark

The timing marks are installed in `src/app/performance/activationBenchmark.ts` and
wired to Tab selection through `DocumentManager.selectDocument`. Nothing has to
be added or rebuilt to take the measurements.

1. Launch Sorakada and open the DevTools console for the webview.
2. Open `small-a.txt` (~10 KB) and `large.txt` (20–50 MB), and set a distinctive
   cursor/scroll position in each.
3. Perform 20 complete cycles, each `small-a.txt` → `large.txt` →
   `small-a.txt`. The recorded run drove the clicks through the WebView2 DevTools
   Protocol, so every activation is still a real Tab-selection event; its results
   are in §12.1.
4. Each activation logs one line:

   ```text
   [sorakada-benchmark] activation doc-2 43.10 ms
   ```

   The measured interval is exactly the SC-005 definition: from the Tab-selection
   event to the first animation frame after the target `EditorState` is bound to
   the shared view and the editor is focused. The time you spend between clicks
   is not part of it.
5. After the 20 cycles, read all 40 measurements from the console:

   ```js
   window.sorakada.benchmark.results()
   ```

   `measurements[i].durationMillis` is the measurement; `documentId` says which
   Tab was activated.
6. Also print the summary the app computes for you:

   ```js
   window.sorakada.benchmark.summarize()
   ```

   ```text
   [sorakada-benchmark] summary count=40 slowest=... medianFirst10=... medianFinal10=...
   ```

7. `window.sorakada.benchmark.reset()` clears the recorded values if a cycle has
   to be discarded and repeated.

Expected:

- each of the 40 measured activations is within 500 ms on the reference development machine
- `medianFinal10 / medianFirst10` is no more than `1.25`
- content/selection/scroll/history remain correct
- memory does not grow continuously merely from repeated switching

The timing marks, this checklist and the recorded measurements are all in place;
§12.1 holds the numbers from the run.

### 12.1 Results (recorded 2026-09-17, 24.0 MB `large.txt`)

| Cycle | small-a → large (ms) | large → small-a (ms) |
|---|---|---|
| 1 | 9.60 | 10.10 |
| 2 | 9.20 | 9.80 |
| 3 | 11.80 | 10.00 |
| 4 | 12.40 | 9.50 |
| 5 | 12.50 | 9.80 |
| 6 | 12.40 | 10.20 |
| 7 | 12.70 | 9.30 |
| 8 | 13.10 | 9.90 |
| 9 | 13.20 | 9.40 |
| 10 | 13.10 | 9.60 |
| 11 | 12.50 | 9.40 |
| 12 | 12.10 | 9.30 |
| 13 | 13.50 | 9.50 |
| 14 | 12.60 | 10.20 |
| 15 | 13.30 | 11.30 |
| 16 | 14.20 | 10.10 |
| 17 | 12.20 | 9.40 |
| 18 | 12.20 | 9.00 |
| 19 | 13.40 | 10.20 |
| 20 | 13.90 | 10.10 |

```text
slowest activation (ms):            14.20     SC-005 limit 500     result: PASS
median of measurements 1-10 (ms):   9.90
median of measurements 31-40 (ms):  11.20
drift ratio (final / first):        1.131     SC-005 limit 1.25    result: PASS
```

All 40 activations are within budget, with a comfortable margin: the slowest is
2.8% of the limit. Content, cursor, scroll and history were still correct after
the 40 switches (`checklist-ui.mjs` group `n19`).

### 12.2 Automated coverage of the measurement itself

`src/app/performance/activationBenchmark.test.ts` pins the parts that can be
checked without a desktop session: the interval closes on the frame callback
rather than at activation, an interrupted activation records nothing, results
keep their order, and the median/drift helpers match the SC-005 arithmetic.

## 13. Browser-only smoke check

Run:

```bash
npm run dev
```

Open the Vite page in a browser.

Expected:

- editor and Tab UI render
- no crash from missing Tauri bridge
- native file dialogs/window controls/drag-drop are not installed

## 14. Regression checks

Verify manually that:

- UTF-8 BOM file preserves BOM after explicit Save
- LF/CRLF behavior remains as in 001
- clean same-path Save remains harmless
- menu and IDEA shortcuts still work through one command route
- `Ctrl+W` closes the current Tab, not the whole app

## 15. Native GUI checklist — executed result

`AGENTS.md` originally forbade driving the native surfaces, so these rows were
handed to the user. That restriction has since been lifted, and the whole
checklist has now been executed under script control:

- the web layer through the WebView2 DevTools Protocol (`verification/cdp.mjs`)
- the Open/Save pickers through Win32 control ids (`verification/uia.ps1`)
- the message boxes through real mouse events on their buttons
- the window itself through `WM_CLOSE`

Every row starts from a freshly launched application. Run them with
`verification/run-group.ps1`.

| # | Scenario | Steps | Expected | Result |
|---|---|---|---|---|
| N1 | Initial Tab | Launch Sorakada | one Tab named `Untitled1`, editor focused | **PASS** 5/5 — see the note below |
| N2 | New Tabs (§4) | `Ctrl+N` twice, type different text in each | `Untitled2`/`Untitled3` appear, `Untitled1` keeps its own text/history/scroll | **PASS** |
| N3 | Tab click | Click between Tabs repeatedly | content, cursor, undo history and scroll position are per Tab | **PASS** — scroll 2008 restored exactly, undo stayed document-local |
| N4 | Untitled numbering (§5) | Save `Untitled1` as `a.txt`, close it, `Ctrl+N` | the new document is `Untitled3`, not `Untitled1` | **PASS** 4/4 |
| N5 | Open adds a Tab (§6) | File > Open `small-a.txt`, then `small-b.txt` | both are open; the first is not replaced | **PASS** 4/4 |
| N6 | Duplicate reuse (§6) | Reopen `small-a.txt` 20 times via File > Open and drag/drop | one Tab for that file; each request activates it; no unsaved prompt | **PASS** 4/4 — 10 picker + 10 drop requests, one session |
| N7 | Save As collision (§7) | Save As an untitled Tab onto the open `small-a.txt` | rejected with an error; both Tabs unchanged and the untitled one stays dirty | **PASS** 5/5 |
| N8 | Save As success (§7) | Save As to a fresh path | Tab renames only after the write succeeds | **PASS** 4/4 — bytes verified on disk |
| N9 | Dirty Tab close (§8) | On a dirty Tab exercise Save / Don't Save / Cancel | Save writes then closes; Don't Save closes; Cancel leaves Tab and active state unchanged | **PASS** 7/7 |
| N10 | Inactive Tab close (§8) | Make Tab A dirty, activate B, close A via its × | the prompt names A, saving/closing never activates A, B stays active | **PASS** 4/4 |
| N11 | Last Tab (§9) | Close the only clean Tab | the next `UntitledN` appears | **PASS** 6/6 — `Untitled2`, clean and active |
| N12 | Window close, cancel (§9) | Three dirty Tabs, close the window, Cancel at a later prompt | the window stays open, earlier saves stay saved, no extra Untitled appears | **PASS** 5/5 |
| N13 | Window close, approve (§9) | Repeat and approve every prompt | the window closes directly, with no replacement Tab created | **PASS** 3/3 — process exited, no leftover dialog |
| N14 | Drag/drop (§10) | Drop `small-a.txt`, a binary file, a directory, `small-b.txt` | overlay appears then clears; both valid files open in order; the failure is reported without blocking; the directory is skipped; the last opened document is active | **PASS** 6/6 — see the note below |
| N15 | Tab overflow (§11) | Open enough Tabs to overflow the strip, activate both ends | the editor is not pushed wider than the window; the strip scrolls; the active Tab is visible | **PASS** 6/6 — 15 Tabs, strip 1398 px inside 1200 px |
| N16 | Ctrl+W (§14) | Press `Ctrl+W` on a dirty Tab | only that Tab is affected; the application does not exit | **PASS** — clean variant 5/5; the dirty variant is exercised by N9 and N10 |
| N17 | BOM/EOL regression (§14) | Open `utf8bom-crlf.txt`, Save unchanged | bytes are identical after Save | **PASS** 4/4 — 514 bytes identical, BOM `EF BB BF` |
| N18 | Browser-only (§13) | `npm run dev`, open the Vite page | editor and Tab strip render; no crash from the missing Tauri bridge | **PASS** 11/11 — headless Chromium, no `__TAURI_INTERNALS__` |
| N19 | Benchmark (§12) | 20 switching cycles | 40 measurements recorded, all within 500 ms, drift ≤ 1.25 | **PASS** 9/9 — see §12.1 |

### 15.1 Automated half — already verified by the agent

```text
npm run typecheck   PASS
npm run test        PASS  (175 tests, 8 files)
npm run build       PASS
cargo test          PASS  (34 tests)
```

Row N18 rendered in a headless Chromium against the same Vite page the desktop
shell loads, so the rendered result is covered rather than merely the HTTP
response.

The automated scenarios of §3 map onto the suite as follows:

| §3 scenario | Where it is pinned |
|---|---|
| 1 monotonic `UntitledN` | `documentManager.test.ts` — creation/tab-order and close suites |
| 2 update routed by callback id | `documentManager.test.ts` — editor update routing |
| 3 dirty toggling both ways | `documentManager.test.ts` — editor update routing |
| 4 inactive Save uses own state/format | `documentManager.test.ts` — save suite |
| 5 delayed A save never mutates B | `documentManager.test.ts` — save suite |
| 6 Save As X then stale X completion | `documentManager.test.ts` — save-as suite |
| 7 same-target writes stay issue-ordered | `documentManager.test.ts` — save suite |
| 8 Save As rejects owned/claimed target | `documentManager.test.ts` — save-as suite |
| 9 inactive close without activation | `documentManager.test.ts` — close suite |
| 10 left neighbour / new first | `documentManager.test.ts` — close suite |
| 11 last Tab is replaced | `documentManager.test.ts` — close suite |
| 12 `prepareCloseAll()` 8 + 14 sequences | `documentManager.test.ts` — window close suite |
| 13 20 duplicate requests, two surfaces | `fileDropController.test.ts` — duplicate reuse |
| 14 failed open creates no session | `documentManager.test.ts` — open suite |
| 15 dropped batch continues in order | `fileDropController.test.ts` — batch orchestration |
| 16 Rust `inspect_file_path` | `file_identity.rs` and `commands/file.rs` unit tests |
| §12.2 timing arithmetic | `activationBenchmark.test.ts` |

Automated coverage includes: monotonic `UntitledN` allocation, per-document
state/history/scroll isolation, snapshot-emission limits, duplicate comparison-key
reuse (a 20-request alternating dialog/drop case), path-resolution identity for
files/directories/missing targets, Save As stale-completion and claim release,
same-path write serialisation, all eight completing and all fourteen aborting
`prepareCloseAll` sequences, two 20-session stress cases, mixed drop batches, and
the SC-005 timing arithmetic.

**Residual gaps in this run.** Three things are worth stating plainly rather
than glossing over:

1. **N14 substitutes the drag source.** The drop was delivered by emitting
   Tauri's own `tauri://drag-drop` event, which reaches the exact listener and
   open pipeline the OS drop would drive. The OLE drag source itself (a real
   `IDataObject` dragged from Explorer) was **not** exercised. Everything above
   that layer — ordering, duplicate reuse, directory skip, failure tolerance,
   final activation, overlay clearing — was.
2. **The native menu was not clicked.** Every command was dispatched through the
   accelerators the menu advertises, and both routes call the same command
   registry, but the menu items themselves were not invoked through Win32.
3. **N18 hit a real browser-only limitation.** In a plain browser `Ctrl+N` is
   Chromium's "new window" accelerator, so the keystroke opens a browser window
   before the application's dispatcher can act on it. That check therefore
   dispatched the event into the page instead. This affects browser-only
   development sessions only, not the desktop shell.

One defect was found and fixed during this run: the editor was not focused at
launch, so N1's "editor focused" clause failed on a fresh start. `Editor.tsx` now
focuses the view it mounts.

