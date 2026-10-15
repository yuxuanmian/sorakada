# Tasks: Core Workspace Visual Baseline — Dark

**Input**: `specs/008-core-workspace-visual-baseline/spec.md` and `plan.md`

**Baseline**: `feature-core` @ `c246ea824aa3b878556d245076ca23c6f362d15f`

**Tests**: Required. 008 is visually driven, so automated tests pin architecture/geometry/token contracts and existing behavior; final aesthetic judgment requires the explicit Tauri/WebView2 manual matrix.

**Organization**: Baseline/safety and shared visual tokens first, then tasks grouped by the five user stories in `spec.md`, followed by cross-cutting regression and convergence.

## Format

`- [ ] T### [P?] [US#?] Description with exact file path(s)`

- **[P]** means the task can be implemented in parallel with adjacent tasks once its prerequisites exist.
- **[US#]** maps the task to the corresponding user story in `spec.md`.

## Global Invariants / No-Freestyle Rule

These are implementation constraints, not suggestions:

- Use the exact first-pass palette, font stack, row heights, Tab frame geometry, Tree feedback geometry and scrollbar geometry frozen in `plan.md`.
- Do **not** substitute a different palette, radius scale, Tab style, Tree selection shape, font family, scrollbar strategy, gradient intensity, or material effect because it “looks better”. Visual changes after this baseline require maintainer review.
- 008 is Dark-first only. Do not add Light theme, system theme switching, Theme Engine, Settings, theme persistence, or appearance persistence.
- Do not add new runtime dependencies. In particular: no icon library, font package, animation library, UI framework, glass/backdrop package, or custom scrollbar package.
- Do not change `src-tauri/**`, Tauri window transparency/configuration/capabilities, Rust filesystem code, or IPC contracts.
- Do not add `backdrop-filter`, Acrylic, Mica, native backdrop APIs, or desktop-background bleed-through. The Editor remains opaque/near-opaque.
- `DocumentManager`, `WorkContextManager`, `ExplorerController`, CodeMirror and Rust keep their existing state ownership. Do not add appearance fields to document/workspace/tree domain models.
- `tabLayout.ts` remains the Tab geometry owner. Decorative CSS must fit *inside* its assigned Tab width; do not add horizontal Tab margins or document-viewport `gap` that the solver cannot measure.
- `ExplorerVirtualTree` remains fixed-height virtualized. Any Tree row-height change must update `density.css` and `density.ts` together before rendering work proceeds.
- Explorer Tree hierarchy guides are in scope. **Editor/code indentation guides are not.** Do not confuse them.
- Syntax Highlight, language adapters and special file-type icons are not 008 bonus work.
- Popups/dialogs/context menus/TopBar/Footer/Empty State are not component-specific redesign targets. If the global Dark tokens affect them, keep their existing geometry/behavior.
- Existing file/tree/tab click, keyboard, open, close, save, watcher, Locate, quick-search and context-target semantics must remain unchanged.
- Short visual transitions may exist only on chrome background/border/opacity states; do not animate text/caret/selection/virtual row transforms/Tab width.

---

## Phase 1: Baseline, Scope Guard, and Visual Safety Net

**Purpose**: Pin the pushed 007 implementation, prove the repository starts green, and record the exact surfaces 008 is allowed to change before any styling work begins.

- [X] T001 Remain on the approved `feature-core` implementation branch and verify its HEAD is `c246ea824aa3b878556d245076ca23c6f362d15f`; if the branch has advanced, stop and re-run code-aware comparison before implementing rather than silently using stale file assumptions. `008-core-workspace-visual-baseline` is the feature/document identifier, not a separate Git branch.
- [X] T002 Run and record the pre-008 gates from the repository root: `npm run typecheck`, `npm run test`, `npm run build`, then `cargo test` from `src-tauri`; do not start 008 with a pre-existing red gate.
- [X] T003 Re-read `.specify/memory/constitution.md`, `AGENTS.md`, `specs/007-ui-structure-foundation/spec.md`, `plan.md`, `tasks.md`, and `consistency-check.md`; explicitly confirm 008 is presentation-only and that 007's state/virtualization/command contracts remain authoritative.
- [X] T004 Confirm `package.json`/lockfile contain no dependency required specifically by 008; record “no new runtime dependency” as the implementation decision and reject any implementation proposal that adds one without maintainer approval.
- [X] T005 Confirm `src-tauri/**` is clean at baseline and add a review checklist item that any 008 diff under `src-tauri/**` is a stop-and-review condition, not normal implementation work.
- [X] T006 Inventory the current target files and record their responsibilities before edits: `src/styles/global.css`, `density.css`, `shell.css`, `tabs.css`, `explorer.css`, `editor.css`, `src/editor/editorConfig.ts`, `src/app/tabs/TabStrip.tsx`, `src/app/explorer/ExplorerRow.tsx`, `ExplorerVirtualTree.tsx`, and `src/app/icons/**`.
- [X] T007 Confirm 007's static CSS audit (`src/ui/cssContract.test.ts`) is green and currently centralizes palette literals in `src/styles/global.css`; do not create a second approved palette file for 008.
- [X] T008 Confirm the existing 100-Tab fixture under `src/app/performance/tabFixtures.ts` and 10,000-row Tree fixture under `src/app/performance/treeFixtures.ts` still run without touching the real filesystem; 008 acceptance MUST reuse them instead of creating duplicate scale fixtures.
- [ ] T009 Record a pre-008 manual screenshot/reference set in a real desktop session for at least: one active document + Explorer, 20+ Tabs, selected deep Tree row, inline Rename/New, Editor current line/selection, and current vertical scrollbar. Keep this as comparison evidence; do not encode screenshots into unit tests.
- [X] T010 Add/prepare `src/styles/visualBaseline.test.ts` (or a focused equivalent) that can import `global.css`, `tabs.css`, `explorer.css`, `density.css` and relevant source as raw text; this test will pin the approved visual contracts without creating a screenshot framework.
- [X] T011 In the new visual contract test, add a scope guard asserting no 008-owned stylesheet contains `backdrop-filter` and no production frontend/config file introduces Acrylic/Mica/native-backdrop/window-transparency imports, API identifiers, or configuration keys. Exclude tests, specifications, documentation and comments from literal-string matching so the audit does not match its own forbidden-term assertions.
- [X] T012 Re-run `npm run typecheck` and the existing CSS/source audit tests after creating the test skeleton, before changing palette/geometry, so later failures are attributable to 008 edits.

---

## Phase 2: Shared Dark Tokens, Appearance Defaults, and Density Contract

**Purpose**: Freeze one central Dark baseline before individual components are restyled. Downstream phases MUST consume these tokens rather than invent local values.

- [X] T013 [P] Add visual-contract assertions in `src/styles/visualBaseline.test.ts` that `src/styles/global.css` declares exactly the 008 base values: `--color-bg:#1b1c1f`, `--color-bg-raised:#22242a`, `--color-border:#343740`, `--color-text:#e3e5e8`, `--color-text-muted:#aeb3ba`, `--color-text-subtle:#747a83`, `--color-line-active:#292c33`, `--color-selection:#3a4555`, `--color-selection-text:#eef1f4`, `--color-accent:#4a8cff`, `--color-caret:#82aaff`, `--color-hover:#272a30`, `--color-active:#30343c`, and `--color-focus-ring:#4f83c5`.
- [X] T014 Update only the central palette declarations in `src/styles/global.css` to the exact values from T013; retain `--color-danger:#b0403a` for the first pass unless a later manual contrast task explicitly rejects it.
- [X] T015 [P] Add visual-contract assertions that `global.css` declares all required 008 semantic surface tokens: `--surface-editor`, `--surface-sidebar`, `--surface-tab-strip`, `--surface-tab`, `--surface-tab-hover`, `--surface-tab-active`, `--border-tab`, `--border-tab-hover`, `--border-tab-active`, `--highlight-tab`, `--surface-tree-hover`, `--surface-tree-selected`, and `--color-tree-guide`.
- [X] T016 Implement the semantic surface variables in `src/styles/global.css` using the exact mixes from `plan.md`: `--surface-editor:var(--color-bg)`; Sidebar 94% raised→transparent; TabStrip 88% raised→base; Tab 78% raised→base; Tab hover 94% Tab→6% text; Tab active 89% Tab→11% text; Tab border 84% border→transparent; Tab hover border 92% border→8% text; active border 58% accent→border; `--highlight-tab:rgb(255 255 255 / 5%)`; Tree hover 5% text→transparent; Tree selected 72% selection→raised; Tree guide 18% muted→transparent.
- [X] T017 [P] Add visual-contract assertions that `global.css` declares `--scrollbar-thumb:rgb(174 179 186 / 28%)`, `--scrollbar-thumb-hover:rgb(174 179 186 / 45%)`, and `--scrollbar-thumb-active:rgb(174 179 186 / 62%)`; do not allow per-component scrollbar colors later.
- [X] T018 Add the three exact scrollbar tokens from T017 to `src/styles/global.css`; do not style any surface yet in this task.
- [X] T019 [P] Add visual-contract assertions for application Editor defaults: `--font-editor` starts with `"JetBrains Mono"`, includes `"Sarasa Mono SC"`, `"Noto Sans Mono CJK SC"`, `"Microsoft YaHei UI"`, then `ui-monospace, monospace`; `--font-size-editor:14px`; `--editor-line-height:1.52`; `--editor-padding-block:10px`; `--editor-line-padding-inline:8px`.
- [X] T020 Add the exact Editor default tokens from T019 to `src/styles/global.css`. Keep `--font-ui` as the UI font and keep general `--font-mono` independent; do not load/download/font-face/bundle JetBrains Mono in 008.
- [X] T021 Add `--motion-fast:120ms` to `src/styles/global.css` and constrain its use to chrome background/border/opacity transitions; do not create a motion settings subsystem.
- [X] T022 Extend `src/ui/cssContract.test.ts` or the new visual contract test so the 007 palette-centralization rule still scans every `src/styles/*.css` plus `src/ui/*.css` after the 008 tokens are added; literal `rgb(...)` values remain legal only in `global.css`.
- [X] T023 Extend the visual audit to fail if any 008 component stylesheet introduces pure black/pure white as a component literal; the central token test already pins softened background/text and should be the only source of those colors.
- [X] T024 [P] Update expected density values in `src/app/shell/density.test.ts` first so the planned Tree heights are explicit: Compact 20px (unchanged), Default 24px (was 22), Comfortable 28px (was 26); keep all Tree indent/chevron values and all Tab/menu/control/TopBar/Footer metrics unchanged.
- [X] T025 Update `src/styles/density.css` Tree row heights to 20/24/28 for Compact/Default/Comfortable and leave every other density token byte-for-byte semantically equivalent to 007 unless formatting requires movement.
- [X] T026 Update `src/app/shell/density.ts` `treeRowHeight` values to 20/24/28 and leave `treeIndent`, `treeChevronSize`, Tab metrics, control metrics and Sidebar defaults unchanged.
- [X] T027 Run `src/app/shell/density.test.ts` and `src/app/explorer/explorerTreeMetrics.test.ts` immediately after T025–T026; fix only density-contract assumptions, not virtualizer behavior, if a test expected the old 22/26 heights.
- [X] T028 [P] Add an assertion to `visualBaseline.test.ts` that 008 did not add a new `[data-theme]`, theme class, theme-storage key, Light palette block, or appearance field to `UiPreferences`; Dark remains the only deliberate palette.
- [X] T029 Change `.sidebar` in `src/styles/shell.css` to consume `var(--surface-sidebar)` instead of directly using the old raised background; make no Sidebar geometry/resizer/content changes in this task.
- [X] T030 Do **not** restyle TopBar/Footer/EmptyState/App Menu/Context Menu after the palette update; inspect them once for legibility and, if contrast is unacceptable, fix the central token hierarchy rather than adding one-off component colors.
- [X] T031 Run `npm run typecheck` and targeted style/density tests after the token foundation; resolve all CSS-contract findings before proceeding to component-specific visual work.
- [ ] T032 Manually render the shell in browser/Tauri once after the palette foundation and reject the phase if the Editor reads as pure black/blue-black, text as glaring pure white, or Sidebar/Tab/Editor already look like unrelated palettes before detailed styling.
- [X] T033 Record the final token table actually implemented in the 008 plan implementation-evidence section/PR notes; if any value differs from the frozen plan because of maintainer review, update `spec.md`/`plan.md`/tests together rather than leaving undocumented drift.
- [X] T034 Re-run the no-freestyle checklist: no new dependency, no `src-tauri` diff, no Light/Settings/theme engine, no popup redesign, no syntax/icon-language additions. Stop here if any leak exists.

---

## Phase 3: User Story 1 — Dark Editor Readability and Feedback

**Purpose**: Make CodeMirror the calmest, most stable surface: JetBrains Mono preference, tuned spacing, subdued gutter, clear current line, stronger selection, and no semantic IDE decoration creep.

- [X] T035 [P] [US1] Extend `src/editor/editorConfig.test.ts` (or add a raw-source companion test) to assert `editorConfig.ts` consumes `var(--font-editor)`, `var(--font-size-editor)`, `var(--editor-line-height)`, `var(--editor-padding-block)`, and `var(--editor-line-padding-inline)` rather than embedding `lineHeight:"1.6"` / raw Editor padding.
- [X] T036 [P] [US1] Add a regression assertion that `appearanceCompartment`, `appearanceBoundary()` and `reconfigureAppearance()` remain present/application-scoped after 008; do not allow the Editor styling refactor to remove the future Settings seam.
- [X] T037 [US1] Update `src/editor/editorConfig.ts` root Editor theme to use `backgroundColor:"var(--surface-editor)"`, `color:"var(--color-text)"`, and `fontSize:"var(--font-size-editor)"`; retain `height:"100%"`.
- [X] T038 [US1] Update `.cm-scroller` in `editorConfig.ts` to use `fontFamily:"var(--font-editor)"` and `lineHeight:"var(--editor-line-height)"`; do not touch scrolling/event behavior.
- [X] T039 [US1] Update `.cm-content` to `padding:"var(--editor-padding-block) 0"` and keep caret color `var(--color-caret)`.
- [X] T040 [US1] Add/adjust `.cm-line` styling to apply `padding:0 var(--editor-line-padding-inline)` so code/text has 8px-class inline breathing room without adding a fake card/container around the text.
- [X] T041 [US1] Restyle `.cm-gutters` only: background `var(--surface-editor)`, ordinary line number hierarchy `var(--color-text-subtle)`, no visible hard divider, and modest right spacing; do not reserve blank width for future breakpoint/diagnostic icons.
- [X] T042 [US1] Keep existing functional folding/bracket behavior from `basicSetup`; if its existing glyph inherits an unreadable color after palette change, adjust only its color through the Editor theme using semantic tokens and do not add a new gutter feature.
- [X] T043 [P] [US1] Add a visual-contract/source assertion that `.cm-activeLine` references `--color-line-active` and `.cm-activeLineGutter` references both the active-line family and `--color-text`; do not test CodeMirror generated class hashes.
- [X] T044 [US1] Set `.cm-activeLine` background to `color-mix(in srgb, var(--color-line-active) 72%, transparent)` as the first-pass value; do not substitute an opaque block because CodeMirror's drawn selection currently sits below line elements.
- [X] T045 [US1] Set `.cm-activeLineGutter` to the same restrained active-line family and set its foreground to `var(--color-text)`; do not change line-number font size/width on activation.
- [X] T046 [P] [US1] Preserve the focused drawn-selection specificity already used in `editorConfig.ts` and assert both focused drawn selection and generic/native selection reference `var(--color-selection)`.
- [X] T047 [US1] Keep the focused CodeMirror drawn-selection background `var(--color-selection)` and add `color:var(--color-selection-text)` only to the native `::selection` rule where it is supported; do not introduce a brittle duplicate text overlay solely to recolor drawn-selection syntax in 008.
- [X] T048 [US1] Keep caret/drop cursor at 2px and `var(--color-caret)`; do not add animated/block/smooth caret behavior in 008.
- [X] T049 [US1] Preserve `&.cm-focused { outline:none }`; focus visibility is supplied by the Editor interaction itself, not a webpage-input-like bright outline around the full Editor plane.
- [X] T050 [P] [US1] Add/extend a static scope test proving `editorConfig.ts` does not import a language package/highlighter and `src/styles/editor.css`/Editor config do not introduce `indent-guide`, minimap, ruler, breakpoint, diagnostic or semantic gutter concepts during 008.
- [X] T051 [US1] Keep `src/styles/editor.css` limited to host/scrollbar needs; do not create a second palette or wrap `.editor-host` in a rounded/card surface.
- [X] T052 [US1] Run existing `editorConfig.test.ts`, document activation, external-reload and Editor handle tests after appearance changes; zero document/history/selection behavior regressions are acceptable.
- [ ] T053 [US1] Manual Editor acceptance: open a document containing Latin code-like text, Chinese comments and long lines; verify JetBrains Mono is preferred when installed, CJK falls through cleanly, 14px/1.52 rhythm is comfortable, and no missing-glyph issue is introduced by the font stack.
- [ ] T054 [US1] Manual state acceptance: compare ordinary line, current line/current line number, selection away from current line, selection crossing current line, multi-line selection and multi-selection. Selection must remain the strongest state; if not, adjust only the approved central current-line/selection tokens/mix percentage with maintainer review and update tests/docs together.
- [X] T055 [US1] Run `npm run typecheck`, `npm run test`, and `npm run build` at the end of Editor styling; do not proceed with a CodeMirror behavior regression hidden behind a visual change.

---

## Phase 4: User Story 2 — Framed, Integrated Tab Visuals

**Purpose**: Give every Tab a clear JetBrains-inspired work-label boundary with Sorakada's restrained material, without changing 007 Tab measurement/overflow behavior.

- [X] T056 [P] [US2] Extend `src/styles/visualBaseline.test.ts` to assert `tabs.css` contains a decorative `.tab::before` (or equivalent named decorative layer), `.tab` remains the logical measured box, and the frame consumes `--surface-tab`, `--border-tab`, `--surface-tab-hover`, `--border-tab-hover`, `--surface-tab-active`, `--border-tab-active`, and `--highlight-tab`.
- [X] T057 [P] [US2] Add a static geometry regression that fails if `.tab` receives horizontal `margin` or `.tab-strip__viewport` receives a document-tab `gap` in 008; `tabLayout.ts` does not measure those values.
- [X] T058 [US2] Change `.tab-strip` in `src/styles/tabs.css` to use `var(--surface-tab-strip)` while retaining its one-row flex geometry, bottom structural border, fixed action sibling and existing `user-select` behavior.
- [X] T059 [US2] Leave `.tab-strip__viewport` flex/overflow geometry unchanged; do not add padding/gap that changes logical offsets. Scrollbar appearance is deferred to Phase 7.
- [X] T060 [US2] Restyle `.tab` to `position:relative`, keep existing flex/gap/height/min/max/padding and remove the old `border-right`/direct background-state styling that would compete with the new internal frame; the logical Tab box stays exactly the width assigned by `TabStrip.tsx`.
- [X] T061 [US2] Implement `.tab::before` as a non-interactive decorative frame with exact inset `2px 1px 1px`, `1px solid var(--border-tab)`, `border-radius:var(--radius-md)`, and idle `var(--surface-tab)` background.
- [X] T062 [US2] Add a restrained idle vertical material treatment only with approved tokens: the frame MAY use a linear gradient whose endpoints are `--highlight-tab`/`--surface-tab`; do not add new literal colors or a strong gloss band.
- [X] T063 [US2] Ensure `.tab` direct content (`label`, state markers, close control) renders above the decorative frame with local stacking/positioning and remains fully clickable; the pseudo-element must use `pointer-events:none`.
- [X] T064 [US2] Implement `.tab:hover::before` using `var(--surface-tab-hover)` and the frozen `var(--border-tab-hover)` border; do not translate, scale, raise, or resize the Tab on hover.
- [X] T065 [US2] Implement `.tab--active::before` using `var(--surface-tab-active)`, `var(--border-tab-active)`, and at most one subtle `inset 0 1px 0 var(--highlight-tab)`/equivalent top highlight; remove the old thick-looking `inset 0 2px 0 var(--color-caret)` active stripe.
- [X] T066 [US2] Keep inactive text `var(--color-text-muted)` and active/hover text `var(--color-text)` unless manual contrast review requires a token-level adjustment; do not create per-Tab text colors.
- [X] T067 [US2] Preserve `.tab__label` flex-grow/ellipsis behavior exactly so the close button stays at the right edge of its assigned width and short labels do not recreate the 007 post-implementation gap defect.
- [X] T068 [US2] Preserve `.tab__dirty` and `.tab__external*` semantics/DOM. Adjust only token consumption if needed for contrast; do not change symbols, introduce badges/chips, or hide them below minimum Tab width.
- [X] T069 [US2] Keep `.tab__close` width/height exactly 18px; add only a small-radius tokenized hover surface/foreground change and ensure border/padding changes do not modify its outer 18×18 geometry.
- [X] T070 [US2] Restyle `.tab-strip__actions` only enough to match the TabStrip surface/border hierarchy; retain the fixed sibling architecture and measured action width.
- [X] T071 [US2] Keep `.tab-strip__action` current hit geometry (`var(--control-height)` × full strip height) and apply the same restrained hover language; do not wrap New/Overview in permanent fake Tab frames.
- [X] T072 [P] [US2] Extend `src/app/tabs/tabPresentationBoundary.test.ts`/source audit to continue rejecting visual fields in `DocumentSession` and to assert 008 did not add `accent`, `tabStyle`, `gradient`, `radius`, `hover` or frame state to document models.
- [X] T073 [P] [US2] Run `src/app/tabs/tabStrip.test.ts` before and after styling and verify `tabLayout.ts` expected widths, fixed-action subtraction, overflow detection and reveal offsets are identical; do not “fix” a failed geometry test by changing the solver to account for decorative CSS.
- [ ] T074 [US2] Use the existing 100-Tab debug fixture and verify frames remain individually visible at the minimum width without becoming thick double-bordered blocks; active Tab must be obvious but not card-like.
- [ ] T075 [US2] In the 100-Tab fixture activate first/middle/final/off-screen Tabs and verify 007 active reveal remains exact; visually confirm the frame inset does not make the active Tab look clipped under the fixed actions.
- [X] T076 [US2] Verify inactive→hover→active transitions are limited to background/border/highlight and use `var(--motion-fast)` where reliable; label/icon/close positions must remain pixel-stable.
- [ ] T077 [US2] Repeat Tab visual acceptance in Compact/Default/Comfortable density; Tab heights remain the existing 26/30/34px and only the frame sits inside those boxes.
- [ ] T078 [US2] Verify zero-Tab state still shows the fixed New action, one Tab still sizes to its natural measured content up to the maximum, and many Tabs remain one row; 008 styling must not reintroduce 004-era scrolling `+` behavior.
- [X] T079 [US2] Run `npm run typecheck`, targeted Tab tests, full `npm run test`, and `npm run build` after Tab styling.

---

## Phase 5: User Story 3 — Explorer Rhythm, Stable Feedback Surface, Guides, and Generic Filled Icons

**Purpose**: Make the file tree slightly more comfortable and visually structured while keeping depth-independent interaction feedback and all 007 virtualization/interaction semantics.

- [X] T080 [P] [US3] Extend `src/styles/visualBaseline.test.ts` to assert `.explorer-row` owns a decorative `::before`/equivalent feedback layer, and that the feedback layer uses the same depth-independent left and right expression `calc(var(--tree-indent) / 2 + 1px)` rather than any `row.depth`/inline width.
- [X] T081 [P] [US3] Add a source regression asserting `.explorer-row:hover` and `.explorer-row--selected` no longer directly paint full-row `background-color`; those states must target the dedicated feedback layer.
- [X] T082 [US3] Change `.explorer-row` in `src/styles/explorer.css` to `position:relative`, transparent direct background and a local stacking context suitable for a decorative feedback layer; preserve display/flex/height/gap/padding/cursor/nowrap behavior.
- [X] T083 [US3] Implement `.explorer-row::before` with `top:1px`, `bottom:1px`, `left/right:calc(var(--tree-indent) / 2 + 1px)`, `border-radius:var(--radius-md)`, `pointer-events:none`, and a transparent idle state. The expression MUST be identical for every depth.
- [X] T084 [US3] Put row content/guides above the feedback layer using local stacking only; do not introduce an arbitrary global `z-index:999...` or move the interaction layer into application overlay infrastructure.
- [X] T085 [US3] Implement hover feedback through `.explorer-row:hover::before { background:var(--surface-tree-hover); }` and update text/icon foreground to the normal primary hierarchy without changing row geometry.
- [X] T086 [US3] Implement selected and selected+hover feedback through `var(--surface-tree-selected)`; selected wins over hover and uses primary text/icon foreground. Do not make selected+hover a third unrelated color.
- [X] T087 [US3] Add `var(--motion-fast)` only to feedback-surface background/border/opacity changes; do not animate row position, height, indentation or virtualizer transform.
- [X] T088 [US3] Replace Tree guide backgrounds in `.explorer-row__guide::before/::after` with `var(--color-tree-guide)` while preserving 1px width/height, elbow/gap semantics and flat guide-slot architecture.
- [X] T089 [US3] Verify guides remain above/legible through hover/selection feedback but remain lower contrast than label/icon; do not add active-scope guide highlighting in 008.
- [X] T090 [US3] Update `.explorer__body:focus-visible` styling if the old full bright outline clashes with the new Tree: keep keyboard focus perceptible using only a subtle tokenized inset/focus treatment and do not move focus ownership off the stable viewport.
- [X] T091 [US3] Keep `.explorer-tree`/`.explorer-tree__row` absolute virtual layout untouched except for style necessary to display the new feedback layer; do not add nested wrappers per depth.
- [X] T092 [P] [US3] Run `density.test.ts`, `explorerTreeMetrics.test.ts` and `explorerVirtualRegression.test.ts` with the 20/24/28 row heights and confirm virtual offsets/total size/mounted bound use the updated metric table rather than stale 22/26 values.
- [ ] T093 [US3] Manual geometry check at depth 0/1/5/10+: hover each row and compare the feedback left/right band. Depth may move chevron/icon/label/guides only; the visible feedback band must not progressively shorten or become label-local.
- [ ] T094 [US3] Manual deep-row check before horizontal scrolling: use a name/depth that forces horizontal overflow and verify the user still sees a substantial hover/selected surface in the current viewport even though the label is far right.
- [X] T095 [US3] Do **not** build a sticky/custom feedback overlay solely to keep the far right rounded corner visible during horizontal overflow; the 008 contract only requires stable depth-independent feedback and visible unscrolled feedback, per `plan.md`.
- [X] T096 [US3] Restyle `.explorer-inline-input` using the existing row-relative height `calc(var(--tree-row-height) - 4px)`, clear `1px solid var(--color-focus-ring)`, small radius, base/Editor dark surface and primary text; preserve Enter/Escape/blur code exactly.
- [X] T097 [US3] Verify inline Create and Rename remain mounted/pinned while virtual scrolling and the new input/feedback CSS does not cause an artificial blur/cancel; reuse existing virtualization tests rather than adding a second state owner.
- [X] T098 [P] [US3] Add `IconDrawMode = "stroke" | "fill"` (or equivalent minimal provider-neutral name) to `src/app/icons/iconTypes.ts` as an optional `IconDescriptor` property/default so existing UI descriptors continue to mean stroke without changing every caller.
- [X] T099 [US3] Update `src/app/shell/AppIcon.tsx`/`IconGlyph` to honor the optional draw mode: normal UI icons remain the existing stroke renderer; filled descriptors render `fill="currentColor"` with only the minimal current-color stroke required for existing open-path glyph legibility. Do not add per-icon hard-coded colors.
- [X] T100 [US3] Update `src/app/icons/fileIconProvider.ts` so primary generic filesystem fallback descriptors (`file`, `folder`, `folder-open`, `other`) request filled mode; keep the `link` badge stroke mode and keep the same five fallback ids.
- [X] T101 [US3] If current generic glyph paths are visually unusable when filled, adjust only `file`, `folder`, `folder-open`, and `other` path artwork in `src/app/icons/glyphs.ts`; preserve the 16×16 viewBox, `currentColor`, safe fallback semantics and all UI action glyphs unchanged.
- [X] T102 [P] [US3] Extend `src/app/icons/icons.test.ts` to assert generic primary filesystem icons request filled mode, link badge remains stroke, every fallback still has artwork, and special names `.gitignore`, `.env`, `package.json`, `Cargo.toml`, `docker-compose.yml`, `.java`, `.html`, `.dart` still resolve to the same generic file fallback rather than new language mappings.
- [X] T103 [US3] Keep `.explorer-row__icon` color subdued through semantic text/icon hierarchy and let selected/hover inherit stronger foreground; do not invent bright folder/file-type colors in 008.
- [ ] T104 [US3] Preserve `.explorer-row__badge` and symlink/junction visibility after filled primary icons; manually verify a filled folder/file plus link badge remains distinguishable at 16px.
- [ ] T105 [US3] Verify loading/error/cycle notice rows keep the same fixed 20/24/28 height and do not receive misleading ordinary selected/hover treatment when disabled; long notice text remains ellipsized with tooltip as in 007.
- [X] T106 [US3] Run existing file single-click/double-click, directory double-click, chevron stop-propagation and Tree focus tests; styling MUST NOT change any interaction handler or add a new one.
- [X] T107 [US3] Run `explorerController.test.ts`, `explorerActions.test.ts`, `explorerReconciliation.test.ts`, `explorerVirtualRegression.test.ts`, and relevant watcher suites to prove the visual change did not alter Tree ownership or filesystem behavior.
- [ ] T108 [US3] Run the 10,000-row fixture top-to-bottom at Default density and verify mounted row count stays viewport/overscan bounded, no row overlap occurs at 24px, and hover/selected feedback follows recycled logical rows correctly.
- [ ] T109 [US3] Switch the same 10,000-row fixture Compact→Default→Comfortable→Default and verify virtualizer remeasurement produces exact 20/24/28 offsets with no stale geometry, blank band or overlapping feedback surface.
- [X] T110 [US3] Verify Tree horizontal extent and scrollbar still derive from the widest materialized row; the feedback redesign must not change width measurement, enumerate unopened directories or mount all rows.
- [ ] T111 [US3] Manually inspect an ordinary real project tree and reject the first pass if 24px Default feels file-manager-loose or if 20px Compact becomes visually cramped because of the new rounded feedback/input; only maintainer-approved metric changes may update the frozen values.
- [X] T112 [US3] Run `npm run typecheck`, full `npm run test`, and `npm run build` at the end of Explorer/icon work.

---

## Phase 6: User Story 4 — Quiet Fixed-Lane Scrollbars

**Purpose**: Replace visually intrusive native-looking scrollbars on the three core work surfaces with one fixed-lane Dark treatment that stays easy to hit and never moves content.

- [X] T113 [P] [US4] Extend `src/styles/visualBaseline.test.ts` to assert the WebView2 baseline uses a constant `12px` vertical/horizontal scrollbar lane, idle `3px` transparent thumb border, hover/active `2px` transparent border, `background-clip:content-box`, strongly rounded thumb, transparent track/corner, and only central scrollbar color tokens.
- [X] T114 [P] [US4] Add a fallback assertion that each targeted scroller keeps standards-compatible `scrollbar-width:thin` / `scrollbar-color:var(--scrollbar-thumb) transparent` (or an equivalent shared declaration) for browser-only development where WebKit pseudo styling is unavailable.
- [X] T115 [US4] Style CodeMirror's scroll container in the existing Editor styling boundary (`editorConfig.ts` theme selectors or `editor.css`, whichever passes the 007 CSS audit cleanly) with a fixed 12px WebKit scrollbar width/height and transparent track/corner.
- [X] T116 [US4] Implement CodeMirror idle thumb with `var(--scrollbar-thumb)`, `background-clip:content-box`, `3px solid transparent` and full/999px radius so the colored core is approximately 6px while the hit lane remains 12px.
- [X] T117 [US4] Implement CodeMirror thumb hover with `var(--scrollbar-thumb-hover)` and `2px` transparent border (~8px visible core) and active/drag with `var(--scrollbar-thumb-active)` while keeping `2px` border; never change the 12px lane.
- [X] T118 [US4] Apply the same 12/3/2 geometry and the same three thumb tokens to `.explorer__body` in `src/styles/explorer.css`; preserve existing `overflow-x` modifier behavior and Header-outside-scroll architecture.
- [X] T119 [US4] Apply the same geometry/tokens to `.tab-strip__viewport` in `src/styles/tabs.css` for horizontal overflow; do not affect the fixed `.tab-strip__actions` region.
- [X] T120 [US4] Ensure `::-webkit-scrollbar-corner` is transparent for Editor/Explorer where both axes overflow so no browser-default square becomes a new high-contrast visual block.
- [X] T121 [US4] Add only background/border transition using `var(--motion-fast)` where WebView2 supports it; if pseudo-element transition support is inconsistent, prefer instant correct state over JavaScript or layout-changing animation.
- [ ] T122 [US4] Manual fixed-lane measurement: record Editor/Explorer content client width before idle→hover→active and assert no width change; the colored thumb may grow from ~6px to ~8px only inside the existing 12px lane.
- [ ] T123 [US4] Manual hit-target check on Windows mouse input: verify the 12px lane is comfortably grabbable even when the idle colored core is ~6px; do not shrink the actual scrollbar lane to match its visual core.
- [ ] T124 [US4] Verify horizontal scrollbar has the same state behavior and that its hover/drag does not move content vertically or change Editor/Tree height.
- [ ] T125 [US4] Run browser-only Vite smoke in at least one non-WebView2 browser path available to the implementation environment and verify unsupported pseudo styling degrades to a usable thin scrollbar rather than hidden/unusable overflow.
- [X] T126 [US4] Confirm no minimap/search/diagnostic/VCS marker or custom JavaScript scrollbar controller was added, then run `npm run typecheck`, `npm run test`, and `npm run build`.

---

## Phase 7: User Story 5 — Coherence, Future Configurability, and Scope Preservation

**Purpose**: Prove 008 is one application-level Dark baseline, not a disguised Theme/Settings subsystem and not a regression to 001–007 ownership rules.

- [X] T127 [P] [US5] Extend `src/styles/visualBaseline.test.ts` to scan `src/styles/*.css` and fail if a component outside `global.css` declares a new hex/rgb/hsl literal; keep `src/ui/cssContract.test.ts` as the primary global audit and avoid duplicating incompatible rules.
- [X] T128 [P] [US5] Add a source audit over `DocumentSession`, `TabSnapshot`, `ExplorerState`, `WorkContext`, `UiPreferences` and related models that rejects newly added visual fields such as `theme`, `palette`, `fontFamily`, `fontSize`, `lineHeight`, `radius`, `gradient`, `scrollbar`, `tabAccent`, `hoverStyle` or `selectionColor`.
- [X] T129 [US5] Verify `UiPreferences` schema/version remains unchanged from 007 (density, Sidebar visibility, Sidebar preferred width only); do not bump the persisted schema merely for non-persisted 008 defaults.
- [X] T130 [US5] Verify `appearanceCompartment` remains application-scoped and no per-session reconfigure call was added during Tab switching/open/reload; future Settings must be able to change Editor appearance without changing document identity.
- [X] T131 [US5] Audit `src/ui/ui.css`, `src/app/menu/**`, TopBar/Footer/EmptyState sources and confirm no 008-specific geometry/material redesign leaked into deferred surfaces; inherited central palette changes are acceptable.
- [X] T132 [US5] Audit all touched CSS for `transform:scale`, Y-translation, width/height animation on Tabs/Tree/scrollbars, heavy box shadow, `filter:blur`, `backdrop-filter`, or large glow effects; remove any such freestyle embellishment.
- [X] T133 [US5] Audit `package.json` and lockfile diff; 008 MUST have zero new runtime dependency and no new font/icon package.
- [X] T134 [US5] Audit `src-tauri/**` diff; 008 MUST have no Rust/Tauri config/capability/window-transparency change. If any exists, revert or stop for maintainer approval.
- [X] T135 [US5] Run watcher/document/path-identity/close-guard regression suites to prove a visual-only feature did not accidentally modify application state code while resolving UI conflicts.
- [ ] T136 [US5] Run the browser-only `npm run dev`/build smoke with Tauri APIs unavailable and confirm Dark core surfaces still render, Editor is usable, overflow works and no styling path assumes native window material APIs.
- [ ] T137 [US5] Run the full Compact/Default/Comfortable density matrix: verify Editor typography does **not** change with density, Tree row height follows 20/24/28, Tab height follows existing 26/30/34, and no persisted appearance state appears.
- [ ] T138 [US5] At 640×400 verify Sidebar/EditorWorkspace remain non-overlapping, the stable Tree feedback band remains visible, framed Tabs do not consume an extra row, and the 12px scrollbar lane does not violate the 320px Editor minimum contract.
- [ ] T139 [US5] At 1200×780 verify the intended hierarchy is visually coherent: Editor is the quietest near-opaque surface, Explorer is slightly material/structured, Tab chrome sits between them, and no core region looks like a separate theme.
- [ ] T140 [US5] Move the desktop app between available 1080p/2160p/different-scale displays and verify the styling uses logical CSS pixels only; no monitor-resolution-specific branch may be introduced to “fix” appearance.
- [X] T141 [US5] Run `npm run typecheck`, full `npm run test`, `npm run build`, and `cargo test` after the complete cross-cutting audit; investigate any Rust diff/test change because none is expected.

---

## Phase 8: Convergence, Manual Visual Acceptance, and Documentation Sync

**Purpose**: Perform the human-facing acceptance that unit tests cannot replace, then analyze spec/plan/tasks and implementation for drift before calling 008 complete.

- [X] T142 Re-read `spec.md` Design Lock + FR-001–FR-070 against the final diff and produce a requirement-to-implementation checklist; every requirement must map to a touched token/style/test/manual check or an explicit “preserved/no change” proof.
- [X] T143 Re-read `plan.md` exact first-pass values against `global.css`, `density.css`, `density.ts`, `editorConfig.ts`, `tabs.css`, `explorer.css` and scrollbar rules; resolve every undocumented value mismatch by updating implementation to plan or obtaining maintainer review and updating docs/tests together.
- [ ] T144 Run the Editor manual matrix in a real Tauri/WebView2 session and record PASS/FAIL for: English/CJK font fallback, ordinary/current line, active line number, selection off/on current line, multiline selection, vertical/horizontal overflow, no fake syntax colors, and no Editor indentation guides.
- [ ] T145 Run the Tab manual matrix with real documents and the 100-Tab fixture and record PASS/FAIL for: inactive/hover/active frame distinction, subtle highlight/gradient, dirty+external combinations, close hover stability, minimum-width overflow, active reveal, fixed New/Overview, all three densities, and “no pill/heavy card” character.
- [ ] T146 Run the Explorer manual matrix with a real project plus 10,000-row fixture and record PASS/FAIL for: slightly spacious Default density, depth 0/1/5/10+ stable-width rounded hover/selection, thin guides, deep-row feedback visible before horizontal scroll, inline New/Rename control visibility, loading/error/cycle rows, filled generic icons, symlink badge, all three densities, and top-to-bottom virtual scrolling.
- [ ] T147 Run the scrollbar manual matrix and record PASS/FAIL for Editor vertical+horizontal, Explorer vertical+horizontal and TabStrip horizontal overflow: idle ~6px visual core, hover/drag ~8px, 12px lane, transparent track/corner, easy mouse hit, and zero adjacent content shift.
- [ ] T148 Compare the 008 workspace against the pre-008/007 visual baseline screenshots. The review question is not “is this final?” but whether the three core regions now share one calm Dark baseline and whether any state feels obviously inconsistent/VS-Code-default/native-browser-like enough to block 008.
- [ ] T149 If maintainer review finds a local aesthetic defect, make only the smallest explicitly reviewed correction and update the frozen token/geometry value in `plan.md` + contract test at the same time; do not use convergence as permission for an unbounded second redesign.
- [X] T150 Run `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` one final time after any manual-review corrections and record counts/results in the implementation evidence/PR description.
- [X] T151 Perform a final production-source/config audit proving no `backdrop-filter`, new theme/settings store, syntax-highlighting dependency, editor-indent-guide implementation, file-extension icon mapping, custom scrollbar JS, new runtime dependency, or `src-tauri` visual change leaked into 008. Exclude tests, specifications, documentation and comments from forbidden-term literal matching, and inspect imports/API identifiers/configuration keys for prohibited platform features.
- [X] T152 Perform a final consistency/analyze pass across `spec.md`, `plan.md`, and `tasks.md`: verify FR ids are contiguous/unique, SC ids contiguous/unique, task ids contiguous/unique, all user-story tags are valid, every exact numeric design decision agrees, every deferred item remains deferred, and no requirement is left without task/manual coverage.
- [ ] T153 Mark 008 ready only after T144–T152 are complete. Preserve the resulting screenshots/notes as the baseline for 009 Search/Replace so 009 can consume this visual language instead of inventing a new Find-widget style.

---

## Dependency / Ordering Notes

- Phase 1 is mandatory before all implementation work.
- Phase 2 tokens/density MUST finish before Editor/Tab/Explorer styling so there is one palette and one geometry baseline.
- Phase 3 (Editor), Phase 4 (Tabs) and most of Phase 5 (Explorer) can proceed independently after Phase 2, but icon-renderer changes in Phase 5 should land before final Explorer manual review.
- Phase 6 should run after component structures are stable; it styles the three actual scroll containers and must not be duplicated in earlier phases.
- Phase 7 requires all visual implementation phases complete.
- Phase 8 is the release/convergence gate and is intentionally human-review-heavy.

## Requirement Coverage Index

| Spec area | Primary task coverage |
|---|---|
| FR-001–FR-010 Visual foundation/scope | T001–T034, T127–T141 |
| FR-011–FR-026 Editor | T019–T020, T035–T055, T144 |
| FR-027–FR-038 Tabs | T056–T079, T145 |
| FR-039–FR-053 Explorer | T024–T027, T080–T112, T146 |
| FR-054–FR-062 Scrollbars | T017–T018, T113–T126, T147 |
| FR-063–FR-070 Preservation/quality | T127–T153 |
| SC-001 | T032, T139, T148 |
| SC-002 | T043–T047, T054, T144 |
| SC-003 | T019–T020, T053, T144 |
| SC-004 | T056–T079, T145 |
| SC-005 | T080–T095, T146 |
| SC-006 | T024–T027, T092, T108–T109, T146 |
| SC-007 | T113–T124, T147 |
| SC-008 | T004–T005, T128–T135, T151 |
| SC-009 | T007, T011, T022–T023, T127, T132, T151 |
| SC-010 | T141, T150 |

## Expected File Touch Summary

Expected primary modifications:

```text
src/styles/global.css
src/styles/density.css
src/styles/shell.css              # Sidebar surface only
src/styles/tabs.css
src/styles/explorer.css
src/styles/editor.css              # only if scrollbar host CSS is used
src/editor/editorConfig.ts
src/editor/editorConfig.test.ts
src/app/shell/density.ts
src/app/shell/density.test.ts
src/app/icons/iconTypes.ts         # minimal draw mode only
src/app/icons/fileIconProvider.ts
src/app/icons/glyphs.ts            # only if generic fill artwork needs correction
src/app/icons/icons.test.ts
src/app/shell/AppIcon.tsx          # render draw mode
src/styles/visualBaseline.test.ts  # new static visual contract
```

Files that should ordinarily remain behaviorally unchanged and are regression targets, not redesign targets:

```text
src/app/tabs/TabStrip.tsx
src/app/tabs/tabLayout.ts
src/app/explorer/ExplorerVirtualTree.tsx
src/app/explorer/explorerController.ts
src/app/explorer/explorerActions.ts
src/app/document/**
src/app/workspace/**
src/ui/ui.css
src-tauri/**
```

A diff that substantially changes those regression-target behavior files should be treated as suspicious and justified against a specific requirement before proceeding.

---

## Implementation Evidence (008)

Recorded by the implementation agent on the `feature-core` branch at baseline commit
`c246ea824aa3b878556d245076ca23c6f362d15f` (T001 verified) plus the working-tree change.
The 31 tasks left unchecked below are the ones that require a real Tauri/WebView2 (or
non-Chromium browser) session; the maintainer visual review remains authoritative for
them, exactly as `plan.md` states.

### Quality gates (T002, T141, T150)

| Gate | Command | Pre-008 (T002) | Post-008 |
|---|---|---|---|
| Typecheck | `npm run typecheck` | PASS, 0 errors | PASS, 0 errors |
| Frontend tests | `npm run test` | PASS, 51 files / 1115 tests | PASS, 52 files / 1183 tests |
| Production build | `npm run build` | PASS, 344 modules | PASS, 344 modules |
| Rust tests | `cd src-tauri && cargo test` | PASS, 145 tests | PASS, 145 tests |

No pre-existing test expectation was rewritten: the new expectations are the 008 density
row heights (T024/T027) and the new audits. Every 007 behavior suite — document manager
(193), explorer controller (54), explorer actions (80), reconciliation (33), workspace
watch coordinator (47), tab strip (43), virtual regression (7), no-reads (6), fixture
isolation (9) — still passes untouched.

### Final token table actually implemented (T033, T143)

`src/styles/global.css`:

| Group | Tokens (exact implemented values) |
|---|---|
| Palette | `--color-bg:#1b1c1f`, `--color-bg-raised:#22242a`, `--color-border:#343740`, `--color-text:#e3e5e8`, `--color-text-muted:#aeb3ba`, `--color-text-subtle:#747a83`, `--color-line-active:#292c33`, `--color-selection:#3a4555`, `--color-selection-text:#eef1f4`, `--color-accent:#4a8cff`, `--color-caret:#82aaff`, `--color-hover:#272a30`, `--color-active:#30343c`, `--color-focus-ring:#4f83c5`, `--color-danger:#b0403a` |
| Surfaces | `--surface-editor:var(--color-bg)`, `--surface-sidebar` 94% raised→transparent, `--surface-tab-strip` 88% raised→base, `--surface-tab` 78% raised→base, `--surface-tab-hover` 94% tab→6% text, `--surface-tab-active` 89% tab→11% text, `--border-tab` 84% border→transparent, `--border-tab-hover` 92% border→8% text, `--border-tab-active` 58% accent→border, `--highlight-tab:rgb(255 255 255 / 5%)`, `--surface-tree-hover` 5% text→transparent, `--surface-tree-selected` 72% selection→raised, `--color-tree-guide` 13% muted→transparent |
| Scrollbar | `--scrollbar-thumb:rgb(174 179 186 / 28%)`, `--scrollbar-thumb-hover:rgb(174 179 186 / 45%)`, `--scrollbar-thumb-active:rgb(174 179 186 / 62%)` |
| Editor/typography | `--font-editor:"JetBrains Mono","Sarasa Mono SC","Noto Sans Mono CJK SC","Microsoft YaHei UI",ui-monospace,monospace`, `--font-size-editor:14px`, `--editor-line-height:1.52`, `--editor-padding-block:10px`, `--editor-line-padding-inline:8px`; `--font-ui` and `--font-mono` unchanged |
| Motion | `--motion-fast:120ms` (chrome background/border/colour only) |

Row heights: `--tree-row-height` 20/24/28 for Compact/Default/Comfortable in both
`src/styles/density.css` and `src/app/shell/density.ts`; every other density metric is
byte-equivalent to 007 and pinned by `density.test.ts`. No value differs from `plan.md`.

Measured legibility of those exact values (WCAG relative luminance, asserted in
`src/styles/visualBaseline.test.ts`): Editor text 13.5:1, gutter 3.9:1 (< text, FR-018),
muted on Sidebar/TabStrip/Tab/footer 7.4:1, text on hover/active Tab ≥ 9.4:1, text on
`--color-danger` 4.6:1 (so T014's retained destructive colour is provably readable),
current line vs Editor base 1.15:1, selection vs Editor base 1.75:1, selection vs current
line 1.52:1 (SC-002 ordering), Tree guide 1.43:1 but below the muted hierarchy (FR-047).

### Automatic contrast/legibility note for the non-target surfaces (T030, T131)

TopBar and Footer inherit `--color-bg-raised` with `--color-text-muted` (7.4:1) and
`--color-text` (12.3:1); Empty State, `src/ui/ui.css`, menus, popovers, context menus,
dialogs and Tab Overview received **no** geometry/material edit (see the diff list below),
so no one-off component colour was needed and the central hierarchy was left alone.

### Scope audit (T034, T132, T133, T134, T151)

Production files changed (complete list):

```text
src/app/icons/fileIconProvider.ts   src/app/icons/iconTypes.ts
src/app/shell/AppIcon.tsx           src/app/shell/density.ts
src/editor/editorConfig.ts          src/styles/density.css
src/styles/editor.css               src/styles/explorer.css
src/styles/global.css               src/styles/shell.css
src/styles/tabs.css
```

Test/audit files changed or added: `src/styles/visualBaseline.test.ts` (new),
`src/app/shell/density.test.ts`, `src/app/icons/icons.test.ts`,
`src/app/tabs/tabPresentationBoundary.test.ts`.

Confirmed absent: any `src-tauri/**` change, any `package.json`/lockfile change (the runtime
dependency set is pinned by a test), any change to `TabStrip.tsx`, `tabLayout.ts`,
`TabOverview.tsx`, `ExplorerVirtualTree.tsx`, `ExplorerRow.tsx`, `explorerController.ts`,
`explorerActions.ts`, `src/app/document/**`, `src/app/workspace/**`, `src/ui/**`, or
`src/app/shell/{TopBar,FooterBar,EmptyState,uiPreferences}.tsx`. No `@font-face` or font
binary exists anywhere in `src`. No `transform`, `filter`, `blur`, `backdrop-filter`,
`box-shadow`, `animation` or `scale()` appears in any 008-touched stylesheet.

### Requirement coverage (T142)

| Requirement | Implementation / evidence |
|---|---|
| FR-001, FR-069 | One Dark palette in `global.css`; no `[data-theme]`, no `prefers-color-scheme`, no Light block, no theme/settings store; `UiPreferences` schema unchanged |
| FR-002, FR-005, FR-006 | Semantic surface tokens consumed by Sidebar/TabStrip/Tab/Editor; `cssContract.test.ts` + `visualBaseline.test.ts` palette-centralisation audits |
| FR-003, FR-004 | `--color-bg:#1b1c1f` (not pure black), `--color-text:#e3e5e8` (not pure white), 13.5:1 — asserted |
| FR-007 | `src/ui/cssContract.test.ts` still reports no `!important`, deep/dependency selector, raw z-index or viewport unit |
| FR-008 | In-app `color-mix`/gradient/alpha only; scope guard forbids `backdrop-filter`, Acrylic/Mica/window-material APIs and any Tauri transparency key |
| FR-009 | `--motion-fast:120ms` on chrome paint properties only; no transition on Editor text/caret/selection; paint-only state audit |
| FR-010 | Diff limited to Editor/TabStrip/Explorer + scrollbars |
| FR-011, FR-012 | `--font-editor` starts with JetBrains Mono, ends `ui-monospace, monospace`, includes Sarasa Mono SC / Noto Sans Mono CJK SC / Microsoft YaHei UI; no font download, `@font-face` or package |
| FR-013, FR-014 | Typography lives in `global.css` as application defaults; `appearanceCompartment`/`appearanceBoundary()`/`reconfigureAppearance()` retained application-scoped and un-called per session |
| FR-015, FR-016 | `14px` / `1.52` / 10px block padding / 8px inline line padding |
| FR-017, FR-018, FR-019 | `.cm-gutters` uses `--surface-editor` with no divider; ordinary numbers `--color-text-subtle` (3.9:1, below text); active number `--color-text` with no geometry change |
| FR-020, FR-021, FR-022 | `.cm-activeLine` 72% line-active mix; `.cm-selectionBackground` + focused layer + native `::selection` on `--color-selection`, with `--color-selection-text` for the native foreground; measured selection > current line > base |
| FR-023, FR-024, FR-026 | No behavior change in `editorConfig.ts`; CodeMirror keeps text/selection/history ownership; caret stays 2px; `basicSetup` folding/bracket untouched (gutter colour reviewed as readable, no change) |
| FR-025 | Source audit: no language package, highlighter, indent-guide, minimap, ruler, breakpoint or diagnostic concept |
| FR-027..FR-034 | `.tab::before` frame (`inset:2px 1px 1px`, `--border-tab`, `--radius-md`, `--surface-tab`, restrained top gradient); hover/active override tokens; `.tab > *` positioned above; no margin/gap; `tabLayout.ts` untouched and `tabStrip.test.ts` green |
| FR-035, FR-036 | Dirty/external marker DOM and semantics untouched; `.tab__close` stays 18×18 with a paint-only hover |
| FR-037, FR-038 | `.tab-strip__actions` remains an untouched sibling of the scrolling viewport; `TabStrip.tsx`/`tabLayout.ts`/`TabOverview.tsx` unchanged |
| FR-039, FR-040 | Tree row height 20/24/28 only; every other density metric pinned at its 007 value |
| FR-041, FR-047 | 1px guides on `--color-tree-guide`, measured visible but below the label hierarchy (1.29:1 at the 13% value set by the guide-polish pass) |
| FR-042..FR-046 | `.explorer-row::before` with `top/bottom:1px` and identical `left/right: calc(var(--tree-indent) / 2 + 1px)` at every depth, `--radius-md`, `pointer-events:none`, no depth term; hover/selected on the layer only; the row box is transparent |
| FR-048..FR-050 | `IconDrawMode` + `drawMode` on `IconDescriptor` (default stroke); the four generic primaries request `fill`; `link` badge stays stroke; `AppIcon` renders `fill="currentColor"` with a hairline current-colour edge |
| FR-051 | `.explorer-inline-input` keeps `calc(var(--tree-row-height) - 4px)`, gains `--surface-editor`, `--radius-md` and the 1px `--color-focus-ring` border; no transition added |
| FR-052, FR-053 | Explorer/controller/virtualization/watcher/no-reads suites green; `ExplorerRow.tsx` and `ExplorerVirtualTree.tsx` unchanged |
| FR-054..FR-062 | Identical `::-webkit-scrollbar` fixed-lane rule sets on `.editor-host .cm-scroller`, `.explorer__body` and `.tab-strip__viewport`: 12px lane, transparent track/corner, `--scrollbar-thumb` with `background-clip:content-box` + `3px solid transparent` + `999px` radius, hover/drag `--scrollbar-thumb-hover`/`--scrollbar-thumb-active` at 2px, plus a gated `@supports not selector(::-webkit-scrollbar)` thin fallback; no marker, minimap or JS scrollbar |
| FR-063 | Full frontend suite + 145 Rust tests green; no save/baseline/dirty/path/watcher semantics touched |
| FR-064 | `package.json` unchanged; the dependency set is asserted against the 007 baseline |
| FR-065 | No `src-tauri/**` diff; `cargo test` unchanged |
| FR-066, FR-067 | Model audit over `DocumentSession`/`TabSnapshot`/`ExplorerState`/`WorkContext`/`UiPreferences` rejects visual fields; the persisted schema is still version 1 with `density`/`sidebarVisible`/`sidebarWidth` |
| FR-068 | Menus, popups, Footer, EmptyState, TopBar untouched; inherited palette verified for contrast |
| FR-070 | All four gates green; the manual matrix is the pending list below |

### Consistency pass (T152)

`spec.md` declares FR-001..FR-070 with no gap or duplicate; SC-001..SC-010 and
SR-001..SR-004 likewise. `tasks.md` declares T001..T153 with no gap or duplicate, and every
`[US#]` tag is in `US1..US5`. Every exact numeric decision (palette hexes, semantic mixes,
font stack, 20/24/28 row heights, `inset: 2px 1px 1px`, `calc(var(--tree-indent) / 2 + 1px)`,
12/3/2 scrollbar geometry) agrees between `plan.md`, the implementation and the contract
test. Every deferred item (Light theme, Theme Engine, Settings, OS backdrop material,
Search/Replace, syntax highlight, editor language guides, file-icon theme, Git UI) remains
absent from the diff.

### Pending manual acceptance (requires a real Tauri/WebView2 session)

These tasks are intentionally left unchecked; they cannot be executed in a
non-interactive environment and the plan makes maintainer visual review authoritative:

- **Baseline/render**: T009 (pre-008 reference screenshots), T032 (first palette render),
  T136 (browser-only smoke), T148 (007 comparison).
- **Editor (T144)** with T053/T054: Latin+CJK font fallback, ordinary/current line, active
  line number, selection off/on the current line, multi-line selection, vertical/horizontal
  overflow, no fake syntax colours, no Editor indent guides.
- **Tabs (T145)** with T074/T075/T077/T078: inactive/hover/active frames, gradient highlight,
  dirty + external combinations, close hover stability, minimum-width overflow, active reveal
  at both edges, fixed New/Overview, all three densities, no pill/card character.
- **Explorer (T146)** with T093/T094/T104/T105/T108/T109/T111: 24px Default feel, depth
  0/1/5/10+ stable feedback band, deep-row feedback before horizontal scrolling, thin guides,
  inline New/Rename, loading/error/cycle rows, filled generic icons, link badge at 16px, all
  three densities, 10,000-row scroll and density switching.
- **Scrollbars (T147)** with T122/T123/T124/T125: ~6px idle / ~8px hover-drag core inside a
  constant 12px lane, transparent track/corner, comfortable mouse hit, zero adjacent content
  shift, horizontal parity, non-Chromium fallback.
- **Cross-region (T137..T140)**: 640×400 and 1200×780 coherence, density matrix, display
  scale changes with no resolution branch.
- **Release gate**: T149 (maintainer review corrections, not triggered so far) and T153
  (freeze screenshots/notes as the baseline for 009 Search/Replace).

### Phase 9 convergence corrections (T154..T157)

Applied to the same working tree; all four gates re-run green afterwards
(`typecheck` 0, `test` 52 files / 1187 tests, `build` 0, `cargo test` 145).

| Task | Correction | Verification |
|---|---|---|
| T154 | `visualBaseline.test.ts` now composites the 72% active line *over* the selection layer and asserts the real ladder `base < current line < selection crossing it < selection`; the alternative-model comparison is kept but labelled as a treatment comparison. Measured composited figure **1.17:1** (the alternative model reports 1.53:1). | New audit test passes; the ≥1.1 floor still fails a mix raised to ~90%. **Maintainer reviewed the 1.17:1 figure and retained the frozen 72% mix** — the selection stays strictly stronger than the current line, and the on-screen "is it ambiguous?" call remains with the manual matrix (T054/T145). |
| T155 | `other`'s mark is now a reverse-wound subpath **inside** the silhouette's `d` (`M6.5 8.5v3h3v-3z`), so nonzero fill subtracts it and it reads as a hole. A separate `<path>` in the same `currentColor` can never show on the filled body — the renderer fills every path element. `file` was deliberately left unchanged: a wedge hole would replace its clean folded-corner silhouette with a rectangular notch. | New `icons.test.ts` area/winding test (a zero-area or same-wound mark now fails), plus a headless-Chromium render at 16px and 64px confirming `other` is visibly distinct while the pre-fix artwork is pixel-identical to `file`. |
| T156 | `.tab-strip__action` gains `border-radius: var(--radius-sm)`, matching `.tab__close` and `.explorer__action`. Paint-only: the fixed width and full-strip hit geometry are pinned by a new assertion. | New Tab-frame audit test. |
| T157 | `.tab::before` now transitions `border-color` only. Probed in headless Chromium: `background-image` gradients are **not** interpolated (`interpolated: false` — the computed value switches discretely), so the fill cannot be faded and the old `background-color` declaration animated only the sliver visible through the gradient's translucent top. Plan §15 permits a non-animated state change. | New audit test rejects a `background-color`/`background-image` transition on the frame. |

## Phase 9: Convergence

Convergence assessed the present code against `spec.md` (70 FR, 10 SC, 4 SR, 40 acceptance
scenarios, 5 user stories), `plan.md` (16 design decisions), `tasks.md` (T001–T153) and the
constitution (5 principles, none violated). No frozen token/geometry value deviates, no 007
contract is broken, no dependency/Rust/Tauri/persisted-state scope leaked, and no runtime
behaviour changed. The four tasks below are the remaining actionable drift.

The 31 unchecked manual tasks (T009, T032, T053, T054, T074, T075, T077, T078, T093, T094,
T104, T105, T108, T109, T111, T122–T125, T136–T140, T144–T149, T153) are human visual
acceptance in a real Tauri/WebView2 session. They are not buildable work and are deliberately
not duplicated here; they stay pending maintainer review.

- [X] T154 Make the SC-002 selection/current-line check model the real CodeMirror stack. `basicSetup` installs `drawSelection()`, which paints its layer *below* the line elements, so the shipped stack composites the 72% `.cm-activeLine` mix *over* the selection rather than choosing between them. Replace the mutually-exclusive `contrast(selection, currentLine)` model in `src/styles/visualBaseline.test.ts` with a composite of the active-line mix over the selection layer, assert the true invariant (the selection region stays strictly stronger than an unselected current line) and record the measured composited figure in the test. If that figure falls below the bar the plan intends, change only the approved central current-line/selection mix with maintainer review and update `plan.md` plus the contract test together — do not silently re-tune the frozen tokens per SC-002, FR-021, plan §5 (partial)
- [X] T155 Keep the filled generic filesystem glyphs individually identifiable. In fill mode `other` currently renders identically to `file`, because its distinguishing mark `M6.5 9.5h3` is a collinear zero-area path and the minimal 0.5px stroke shares the fill colour, so the "stays distinguishable at row size" property documented in `glyphs.ts` is lost and the `file` dog-ear stops reading. Adjust only the `file`, `folder`, `folder-open` and `other` path artwork in `src/app/icons/glyphs.ts` so the filled form keeps a visible mark, preserving the 16×16 viewBox, `currentColor`, safe fallback semantics and every UI action glyph unchanged; extend `src/app/icons/icons.test.ts` so a zero-area fill-mode mark fails. Do not expand the icon vocabulary or add per-extension mappings per FR-048, FR-049, plan §12, T101 (partial)
- [X] T156 Give the fixed New/Overview controls the small-radius hover language the plan requires. `.tab-strip__action` currently hovers `var(--color-hover)` with no `border-radius`, unlike `.tab__close` (`tabs.css`) and `.explorer__action` (`explorer.css`). Apply the same tokenized small-radius hover surface while keeping the fixed measured action width and the full-strip-height hit geometry, confirm the control still reads as a control rather than a fake framed document Tab, and confirm the overflow-state strip height does not turn it into a pill. Do not wrap New/Overview in permanent Tab frames or move them into the scrolling viewport per plan §8, FR-037, T071 (partial)
- [X] T157 Remove the ineffective fill transition on the Tab decorative frame. `.tab::before` transitions `background-color`, but the visible fill is the `background-image` gradient whose bottom stop is opaque `--surface-tab`, so the hover/active fill change snaps while only `border-color` animates. Either make the property that visibly changes the animated one or drop the dead declaration, keeping the transition at `var(--motion-fast)`, confined to background/border/opacity, and never animating Tab/Tree geometry, position or the scrollbar lane per plan §15, FR-009, T076 (partial)

## Phase 10: Island Layout (008 Visual Polish)

A direct maintainer checklist layered on top of the 008 baseline: the work area
becomes light islands on a slightly deeper canvas instead of continuous columns
cut by full-height dividers. Presentation only — no behaviour, resize, virtualizer,
Tab-overflow, document, Explorer-controller or WorkContext change, and no new
dependency, state owner or window material.

Tokens: `--color-canvas` `#121317`, `--surface-canvas`, `--border-island`
(`color-mix(in srgb, var(--color-border) 70%, transparent)`) and `--island-inset`
(an alias of the density-owned `--island-gap`, so the window inset and the
inter-island gap can never disagree). `--island-gap` is a **new** density metric
at 6/8/10 for Compact/Default/Comfortable, pinned on both sides by
`density.test.ts` / `DENSITY_CSS_VARIABLES`.

- [X] T158 Add the canvas/island semantic tokens to the central layer (`global.css`), with the canvas a light step below the darkest work surface (FR-006)
- [X] T159 Give the AppShell MainArea one uniform inset plus the inter-island gap, revealing the canvas (FR-010)
- [X] T160 Make the Sidebar an independent island: weak rim border, small radius, one surface, no full-height right divider
- [X] T161 Make the EditorWorkspace an independent island on `--surface-editor`, keeping its frozen 320px minimum
- [X] T162 Keep TabStrip and EditorHost one continuous island surface — no second card, no divider between them (T056..T057)
- [X] T163 Remove the hard separators the island layout makes unnecessary: the Sidebar right border and the `.tab-strip` bottom border
- [X] T164 Keep the Sidebar resizer easy to hit: the strip now spans the whole gap (gap + 1px rim, never overlapping the Editor island), with the visible indicator still `--sidebar-resizer-width` wide
- [X] T165 Confirm no layout anomaly at the 640×400 minimum: measured Editor island 362/356/350px at Compact/Default/Comfortable, all ≥ the 320px minimum, with no clipping or overlap. `MAIN_AREA_CHROME_WIDTH` was corrected from the 4px splitter to `3 × widest island gap` (30) because the inset now counts toward the measured MainArea — the clamp *logic* is unchanged, but without this the Editor would be clipped at the extreme drag limit
- [X] T166 Confirm all three densities: `--island-gap`/`--island-inset` measure 6/8/10 and the inset is uniform on every side at 1200×780 and 640×400
- [ ] T167 Confirm the 100-Tab fixture is unchanged — pending a real Tauri/WebView2 session: the fixture needs 100 real documents, and `uiDebugState` exposes no fixture toggle (only Tree row bounds / virtual range). Structurally, `tabLayout.ts`, `TabStrip.tsx` and every Tab density metric are untouched; the strip viewport is simply narrower by the island chrome
- [ ] T168 Confirm the 10,000-row Tree fixture is unchanged — pending a real Tauri/WebView2 session for the same reason. `treeRowHeight` stays 20/24/28 (pinned), the virtualizer is untouched, and only the viewport box shrinks by the chrome
- [X] T169 `npm run typecheck` — pass (0)
- [X] T170 `npm run test` — pass, 52 files / 1193 tests
- [X] T171 `npm run build` — pass
- [X] T172 `cargo test` (from `src-tauri`) — pass, 145 tests
- [ ] T173 Manual screenshot acceptance — browser-level evidence already captured and handed over (real built app at 1200×780 and 640×400, all three densities; gap/inset pixels verified as `#121317` canvas, Sidebar `#212329`, Editor plane `#1b1c1f`, TopBar/Footer `#22242a`). Final WebView2 aesthetic sign-off remains with the maintainer

### Island layout evidence (measured in the built app)

| Check | Result |
|---|---|
| Inset = gap = 6/8/10 (Compact/Default/Comfortable) | measured on all four sides at both window sizes |
| Editor island width at 640×400 | 362 / 356 / 350 px — every density ≥ 320 |
| Island radius / border | 5px (`--radius-md`) / 1px `--border-island` on both islands |
| TabStrip ↔ EditorHost | `.tab-strip` bottom border **0px** — one continuous surface |
| Sidebar right divider | replaced by the gap plus the weak rim border |
| Resizer | spans gap + 1px rim, centred within 0.5px of the gap centre, never overlaps the Editor island |
| TopBar / Footer | full viewport width (1200 / 640) — the Footer deliberately stays a full-width band rather than becoming an island, preserving its structural semantics |
| Rendered pixels | canvas/insets `#121317`, Sidebar `#212329`, TabStrip `#212329`, Editor plane `#1b1c1f`, TopBar/Footer `#22242a` |

Explicitly *not* changed: `TabStrip.tsx`, `tabLayout.ts`, `ExplorerVirtualTree.tsx`,
`ExplorerRow.tsx`, `DocumentManager`, `ExplorerController`, `WorkContext`, `src/ui/**`,
the ContextMenu/Dialog/Tooltip surfaces, `src-tauri/**` and the dependency set. The
Explorer header rule and the TopBar/Footer window-chrome borders were left in place
because they are internal content/chrome separators, not inter-island dividers.

## Phase 11: Island Layout & Top Chrome Ambient (008 Visual Polish, second pass)

Adds the environment light on top of Phase 10. Scope guards for this pass: CSS/tokens/
presentation only — no behaviour, dependency, state owner, Settings, Theme Engine,
Mica/Acrylic or Tauri transparency change, and no Dialog / ContextMenu / Tooltip /
Footer-function / Search / syntax-highlighting redesign. The whole pass is tokens plus
seven stylesheet rules; no new element and no new stacking layer was needed.

- [X] T174 Respect the scope guards: the diff touches `global.css`, `shell.css` and the audits only — no component, model, controller, dependency or `src-tauri/**` change
- [X] T175 Establish the canvas / island / chrome / border / ambient-accent semantics centrally: `--surface-canvas`, `--border-island`, `--radius-island`, `--island-inset`, `--chrome-surface`, `--chrome-border`, `--chrome-sheen`, `--ambient-accent`, `--ambient-height`, `--ambient-peak`/`-plateau`/`-mid`/`-afterglow`, `--ambient-radial`, `--ambient-linear`, `--chrome-ambient`. No component declares a new literal
- [X] T176 Make the App's bottom layer a stable Dark canvas (`--color-canvas` `#121317`), a step below every work surface, so the island gaps read as background space
- [X] T177 Give the MainArea the island layout with one uniform gap between Sidebar and EditorWorkspace (Phase 10 T159..T162)
- [X] T178 Drive the gap from the shared density token: 6/8/10 for Compact/Default/Comfortable (Phase 10 T158)
- [X] T179 Keep the outer inset from breaking the 640×400 minimum — measured Editor island 362/356/350px, all ≥ 320 (Phase 10 T165)
- [X] T180 Sidebar as an independent island: small radius, weak rim border, light surface contrast, no card shadow (Phase 10 T160)
- [X] T181 EditorWorkspace as an independent island (Phase 10 T161)
- [X] T182 Keep TabStrip + EditorHost one Editor island surface — no gap, no second radius, no border between them (Phase 10 T162)
- [X] T183 Remove the dividers the islands replace, and make `--chrome-border` translucent so the ambient crosses the TopBar seam instead of being cut by an opaque line
- [X] T184 Leave the Explorer selected/hover geometry untouched: no indent or hit-area redesign
- [X] T185 Keep a reliable Sidebar resizer hit area inside the gap — the strip spans the gap (+ rim) and never overlaps the Editor island
- [X] T186 Build **one** Top Chrome Ambient definition used as canvas/chrome environment light, never a purple background per component
- [X] T187 Use the cool accent (`#9b75e8`) only through low-opacity mixes — 12% peak / 5% mid / 3% afterglow, never a saturated block
- [X] T188 Concentrate the light in the top-left TopBar rather than washing the whole bar evenly
- [X] T189 Horizontal falloff reaches zero at ~67% of the viewport width (measured; spec allows 60–70%)
- [X] T190 Vertical falloff returns to the plain canvas by ~135px (measured; spec allows 100–140px)
- [X] T191 Use the recommended two-layer construction: radial owns the top-left light, linear only lengthens the TopBar afterglow. The canvas takes the radial alone, because a horizontally-uniform layer in a fixed-height band would end in a hard step
- [X] T192 Take the ambient's presence from area and gradient length, not from saturation
- [X] T193 TopBar takes the strongest ambient; the canvas below continues the same field
- [X] T194 TabBar stays clearly weaker than the TopBar — the Editor island is opaque, so the strip is neutral and the light stops at the island edge by construction
- [X] T195 Editor body stays a stable, near-solid surface with no ambient tint
- [X] T196 Explorer body gets no ambient tint (the allowed upper bound is "very slight"), so it cannot become a purple-black theme
- [X] T197 Return the right-hand window controls to neutral Dark — measured `#22242a` across x=1080..1199
- [X] T198 Add no neon glow, outer glow, large blur or coloured shadow — verified: no `filter`/`backdrop-filter`/`box-shadow`/`blur` in any stylesheet
- [X] T199 Keep the Active Tab's own frame/border logic and the Tab small-radius framed language; the gradient does not replace state distinction
- [X] T200 Check the TopBar → TabBar → Editor vertical transition: measured continuous across the seam at all three densities (peak `#332f45` at y=0 in every density; boundary exactly at 30/34/38px) with no purple end line
- [X] T201 Check the Sidebar → gap → Editor hierarchy: the gap is lit canvas, not a thick black border
- [X] T202 Check the scrollbars: vertical and horizontal thumbs sit inside the island viewport, inset from the island's outer edge; the rounded corner cuts only transparent track (verified at 3× against the real stylesheet)
- [X] T203 Check the horizontal Tree scrollbar: the extent calculation is untouched (`explorerTreeMetrics` unchanged); only the viewport box shrank by the island chrome
- [X] T204 Check all three densities, not just Default: the ambient geometry is identical in every preset (viewport-anchored), and only the TopBar height shifts the seam
- [ ] T205 Verify the 100-Tab fixture — pending a real Tauri/WebView2 session (needs 100 real documents; no fixture toggle exists in `uiDebugState`). Structurally `tabLayout.ts`, `TabStrip.tsx` and all Tab density metrics are untouched
- [ ] T206 Verify the 10,000-row Explorer fixture — pending a real Tauri/WebView2 session for the same reason. `treeRowHeight` stays 20/24/28 and the virtualizer is untouched
- [X] T207 Check empty/composition states: zero-Workspace + zero-Tab and the document-only (Sidebar hidden) layout were rendered and leave no stray shell or orphan gap. Workspace-only still needs a real session
- [X] T208 Check the narrow window: at 640×400 the inset/gap keep the structure stable with no Sidebar/Editor overlap
- [X] T209 Introduce no `!important`, dependency-internal selector, component-local palette literal or new raw `z-index` — verified by grep and by the existing `cssContract` / `visualBaseline` audits
- [X] T210 `npm run typecheck` — pass (0)
- [X] T211 `npm run test` — pass, 52 files / 1197 tests
- [X] T212 `npm run build` — pass
- [X] T213 `cargo test` (from `src-tauri`) — pass, 145 tests
- [ ] T214 Final real-Tauri Dark UI manual acceptance and screenshots. Browser-level evidence is captured (real built app, 1200×780 and 640×400, three densities, sidebar-hidden composition, 3× scrollbar probe); the "有氛围但不明显是一块紫色 / 纵向收得够快 / Editor 仍安静" judgement is the maintainer's

### Ambient tuning levers (for the maintainer pass)

Adjust in this order, per the checklist: if the purple reads too strong, lower the
mixes on `--ambient-peak`/`--ambient-plateau`/`--ambient-mid`/`--ambient-afterglow`;
if it reads too weak, lengthen the horizontal falloff or widen the radial's
percentages — do **not** raise saturation. If the result feels too "card-like",
reduce `--border-island` / `--radius-island` before touching `--island-gap`.

The brightness guard is now derived, not hard-coded: `visualBaseline.test.ts` reads
the accent weights back out of `global.css` and composites them (plus
`--chrome-sheen`) over the chrome surface, then asserts muted chrome text still
clears 4.5:1. Raising the ambient past what the TopBar text can carry therefore
fails the audit instead of shipping.

**Reshaped profile (second ambient pass).** The radial became a flatter, wider
ellipse centred at 12% with a four-stop profile, so the bright mid-tone is a
*plateau* rather than a corner hot-spot, and the linear afterglow now peaks at the
same 12% instead of at the window corner. `--ambient-height` dropped 140 → 128px and
the TopBar gained the neutral `--chrome-sheen` for its lit-glass read. A follow-up
trim shortened the horizontal reach to about three quarters (`46%` semi-axis,
linear to `55%`) because the first shape read as stretched; the bright region was
deliberately left untouched and only the tail was pulled in.

Measured at Default 1200×780 (B−R is the purple indicator; the neutral chrome
surface is `#22242a`, B−R = 8):

| Axis | Measurement |
|---|---|
| TopBar peak at 12% | `#3e3853`, B−R = 21 — the brightest point sits just right of the corner (0% measures 18) |
| TopBar bright plateau 10–30% | 20 → 19 |
| TopBar weak afterglow 35–50% | 16 → 11 |
| TopBar converged from ~60% | 7–8 — fully neutral, window controls included |
| Vertical at left edge | y=34 → 14, y=70 → 11, y=90 → 9, y=110 → 6, y≥124 → 5 (plain canvas); unchanged by the horizontal trim |
| Work islands | no tint — Sidebar `#212329` and Editor `#1b1c1f` are identical to the pre-ambient values |

## Phase 12: Explorer Tree Guide Polish

Direct maintainer checklist. Presentation only: interaction, expand/collapse,
selection, virtualization and the projection's data semantics are untouched —
`flattenVisibleExplorerRows` and the `ancestorContinuation` flags are unchanged, and
the only logic edited is the *class* derivation for a guide slot, which now reads that
existing flag instead of ignoring it.

The regression this pass fixes: the deepest indent slot was elbowed unconditionally,
so a level's line was cut at every row's middle. The skeleton rendered as a dashed
line with a gap beside every chevron. The line now stops only where the level
genuinely ends — at the last sibling — so consecutive rows tile into one hairline.

- [X] T215 Only guide visuals and in-row structure changed; no interaction, expansion, selection, virtualization or model semantics touched
- [X] T216 A level's line is one continuous hairline: every slot that still has siblings below it spans the full row height, so consecutive rows tile seamlessly instead of breaking beside each chevron
- [X] T217 The chevron no longer substitutes for the line — an expanded node that really has child rows carries a short segment from the chevron down to the row's bottom, where its first child resumes the same column
- [X] T218 The deepest slot always pulls a short horizontal connector out to the chevron/icon/label — a `├` while siblings follow, a `└` at the last one
- [X] T219 A level with siblings below keeps its line running through the row
- [X] T220 Only the last sibling stops a line, at exactly the row's middle (measured `bottom: 12px` of a 24px row)
- [X] T221 An expanded directory's children share the parent-level skeleton rather than showing broken segments
- [X] T222 Guides stay one hairline (1px) in the dedicated low-contrast token, with no glow, gradient or active-scope emphasis
- [X] T223 Guide intensity is now clearly weaker than the selected/active fill while still stronger than the hover tint, so hover cannot erase the skeleton — **frozen token changed `--color-tree-guide` 18% → 13% with maintainer sign-off**, with `plan.md` §2 synced. Measured 1.29:1 guide, 1.53:1 selected fill, 1.13:1 hover tint
- [X] T224 Hover/selected fills do not erase the structure: guides are positioned children of the row, so they paint above the feedback layer and stay readable over both states
- [X] T225 Island layout, row heights, indent scale and the unified-width hover/selection surface are untouched
- [X] T226 Deep, many-sibling and mixed expand/collapse shapes verified against the real projection: continuing rows carry no `stop`, last siblings carry it, and levels that ended above carry `gap`
- [X] T227 Last node, single-child chain, empty directory and file nodes verified. An expanded-but-empty directory no longer dangles a segment (no `--branch`), and a single-child chain collapses to `gap` levels
- [ ] T228 10,000-row fixture — pending a real Tauri/WebView2 session. Nothing in the virtualization path changed (CSS plus a class derivation; `treeRowHeight` and the virtualizer untouched), and the audit pins that guides add no layout, but the mounted-row bound and scroll behaviour need real eyes
- [X] T229 `npm run typecheck` — pass (0)
- [X] T230 `npm run test` — pass, 52 files / 1205 tests
- [X] T231 `npm run build` — pass
- [X] T232 `cargo test` (from `src-tauri`) — pass, 145 tests
- [ ] T233 Manual acceptance in a real session: the goal is a Tree that reads as one continuous skeleton, not per-row chevrons with broken stubs

### Guide geometry evidence (computed styles, Default density)

Row height 24px, indent 14px, read back from the real stylesheet in headless Chromium:

| Slot | `::before` | Meaning |
|---|---|---|
| plain / `--stub` with a following sibling | `top: 0; bottom: 0` | full-height line, tiles with the rows above and below |
| `--stub --stop` (last sibling) | `top: 0; bottom: 12px` | stops at exactly the row's middle |
| `--gap` (level ended above) | `display: none` | draws nothing at all |
| deepest slot `::after` | `7px × 1px` | the horizontal connector, half the indent |
| `--branch` chevron `::after` | `12px × 1px`, `pointer-events: none` | chevron-to-child segment; absent on an expanded empty directory, and it cannot widen the chevron's hit area |

Real projection fixture (15 rows): `Button.tsx`/`Card.tsx` received `[plain, plain, stub]`
— no `stop`, so their line continues through them — while `Modal.tsx` received
`[plain, plain, stub+stop]`. Before this pass all three stopped at 50%.

## Phase 13: Purely Vertical Guides (final guide design)

Supersedes the connector design of Phase 12: the Tree now draws **only vertical
lines**. There is no `├`/`└`, no horizontal stub, no half-height stop and no hidden
level — which makes the rendering rule collapse to "one full-height line per
ancestor level", and the row only has to get the *count* right.

Why that is sufficient, and why no per-level flag is needed: slot `j` corresponds to
the ancestor at depth `j`, and by construction **every** row of a subtree has that
slot, while the row after a subtree is always shallower (the sibling directory's own
row) and therefore has no slot in that column. So each expanded directory's guide
covers exactly its visible subtree and stops by itself. That ordering property is a
property of the depth-first projection, not of the guide code, so it is now pinned by
its own test in `explorerProjection.test.ts`.

- [X] T234 Each expanded directory corresponds to exactly one purely vertical guide
- [X] T235 The guide extends downward from below the parent directory and covers its entire visible subtree
- [X] T236 It ends naturally after that directory's last visible descendant — because the next row in the flat order is shallower and has no slot in that column
- [X] T237 Several expanded levels produce several parallel vertical lines, one per ancestor depth (verified: `leaf.ts` at depth 4 draws four)
- [X] T238 A collapsed directory produces no downward subtree guide (`docs`, `junction`: no rows below them belong to their subtree)
- [X] T239 Ancestor guides pass through every descendant row and are cut by neither the chevron nor the icon: the slots are positioned row children painted above the hover/selection feedback, and every guide column sits left of the row's own chevron column
- [X] T240 Still 1px in the low-contrast `--color-tree-guide` (13%), purely a hierarchy aid
- [X] T241 All elbow geometry deleted: no `::after` stub, no `--stop`/`--gap`/`--stub`/`--elbow`/`--branch` selectors, and no `bottom: 50%` remains — asserted over the whole stylesheet
- [X] T242 Row height, indent, interaction, virtualization and Tree data semantics untouched. `explorerProjection.ts` is not in the diff; `ancestorContinuation` is still produced and still pinned by its own tests, but the pure-vertical design no longer needs its values — only the slot *count*, which `guideSlotCount` now names

### Vertical guide evidence (computed styles, Default density)

Row height 24px, indent 14px, read back from the real stylesheet in headless Chromium:

| Check | Result |
|---|---|
| Horizontal segments anywhere | **none** — `getComputedStyle(slot, "::after").content === "none"` for every slot, and no guide/chevron `::after` rule exists |
| Slot count per row | exactly `depth` (0,1,2,3,3,3,2,2,1,1,2,3,4,1,1 across the 15-row fixture) |
| Line geometry | `top: 0; bottom: 0; width: 1px` on every slot — full height, so rows tile |
| Colour | `#aeb3ba` at 13% — fainter than the selected fill, brighter than the hover tint |

`npm run typecheck` 0 · `npm run test` 52 files / 1203 tests · `npm run build` pass ·
`cargo test` 145. Still pending a real session: the 10,000-row fixture (T228) and the
visual sign-off (T233).

## Phase 14: Unseparated Top Chrome, Tighter Top Inset

Direct maintainer checklist. The TopBar loses its full-width separator, and the work
area's inset above the islands becomes the smaller `--island-inset-top`
(`calc(var(--island-gap) / 2)` → 3/4/5px for Compact/Default/Comfortable) so the
islands tuck in under the chrome while still keeping a real gap.

- [X] T243 Delete the TopBar's `border-bottom` / full-width separator
- [X] T244 Shrink the MainArea's *top* inset so both islands move up; sides and bottom keep the uniform `--island-inset`
- [X] T245 Keep a small gap between the chrome and the islands — the top inset is half the island gap, never zero
- [X] T246 Explorer/Editor keep their own rim borders untouched, so they remain the primary boundary
- [X] T247 The purple ambient shows no visible cut at the TopBar's bottom: the TopBar's extra layer was changed from a horizontally-uniform `linear-gradient` to `--ambient-halo`, a second ellipse sized to the bar's own height, so it is already zero on the seam. Both sides of the seam are then the identical radial
- [X] T248 TopBar height, drag region and window controls unchanged — only the bar's `border-bottom` and its layer sizing were edited, and the sub-element rules are untouched in the diff
- [X] T249 Top layout verified at 640×400, 1200×780 and 1600×900 in all three densities: no overlap, no misalignment, and no size-dependent branch, so a maximize/restore re-measure cannot shift the top band

### Seam and top-layout evidence

Row height of the chrome band unchanged, measured in headless Chromium against the
built stylesheet:

| Check | Result |
|---|---|
| TopBar height | 30 / 34 / 38px, unchanged |
| TopBar `border-bottom-width` | **0px** |
| Drag region / window-control height | 30 / 34 / 38px — they fill the bar, as before |
| MainArea `padding-top` | 3 / 4 / 5px (half of the 6 / 8 / 10 island gap) |
| Gap between TopBar and the islands | 3 / 4 / 5px — non-zero at every density |
| Side/bottom inset and inter-island gap | 6 / 8 / 10px, unchanged |
| Overlap at 640×400 / 1200×780 / 1600×900 | none, in all three densities |

**Ambient continuity across the seam**, measured by solving the light's effective
alpha from the blue channel on each side (the surfaces differ by design — chrome
above, canvas below — so the alpha, not the raw pixel, is what has to match):

| x | alpha above the seam | alpha below | difference |
|---|---|---|---|
| 150 | 0.1526 | 0.1483 | −0.0043 |
| 300 | 0.1421 | 0.1388 | −0.0033 |
| 500 | 0.0579 | 0.0526 | −0.0053 |
| 600 | 0.0263 | 0.0239 | −0.0024 |
| 700 and beyond | 0.0000 | 0.0000 | 0.0000 |

The residual is at the 8-bit quantisation floor (one step in a 190-unit span is
≈0.004), so the light field is equal on both sides of the seam: the purple is not
cut. Removing a 1px border inside a fixed-height flex item cannot move the layout
either — the islands' outer geometry is byte-identical to Phase 13 apart from the
4px they gain on top.

## Phase 15: TopBar as a Light Overlay

Direct maintainer checklist. The TopBar stops being an opaque raised band and
becomes a translucent wash over the canvas, leaving the purple ambient as the only
thing that gives the top of the window its presence.

- [X] T250 Weaken the TopBar's solid fill toward the canvas: `--chrome-surface-top` is now `color-mix(in srgb, var(--chrome-surface) 20%, transparent)`, so the canvas carries 80% of the bar's colour
- [X] T251 It is expressed as a *translucent* wash rather than a second opaque colour, which is what makes it behave like an overlay layer — and it keeps following the canvas if that ever moves
- [X] T252 The purple ambient stays the main source of atmosphere: it is untouched, and it is now the only thing separating the bar from the canvas
- [X] T253 The transition into the Explorer/Editor islands is softer. Measured: the bar-to-canvas separation fell from `#22242a` (1.197:1) to `#18191d` (**1.057:1**), which is now *below* the canvas-to-Editor separation of 1.089:1
- [X] T254 The neutral `--chrome-sheen` was halved (4% → 2%). This was forced by measurement, not taste: at 4% white, even a 15% wash keeps the bar at 1.126:1, because a few percent of white is what actually lifts a surface this dark out of the canvas field
- [X] T255 The window chrome text gains contrast rather than losing it — measured 5.6:1 for `--color-text-muted` over the ambient-tinted bar, against 4.9:1 before
- [X] T256 Nothing else moved: TopBar height, drag region, window controls, the removed separator, the top inset and the islands' geometry are unchanged from Phase 14

### Overlay evidence

The invariant is stated against an existing ratio instead of an arbitrary ceiling:
the bar must be **no more separated from the canvas than the canvas already is from
the Editor island**. Both inputs are read back from the stylesheet, so raising
either the wash or the sheen fails the audit rather than quietly restoring the band.

| Wash | Sheen | bar ↔ canvas | canvas ↔ Editor | Verdict |
|---|---|---|---|---|
| 30% | 4% | 1.1586 | 1.0895 | separate band |
| 30% | 2% | 1.0988 | 1.0895 | separate band |
| 20% | 4% | 1.1365 | 1.0895 | separate band |
| **20%** | **2%** | **1.0794** | **1.0895** | **inside the canvas field** |
| 15% | 2% | 1.0700 | 1.0895 | inside the canvas field |

Rendered pixels at Default 1200×780 (no purple region, so this is the base surface):

| Sample | Before this pass | After |
|---|---|---|
| TopBar base | `#22242a` | `#18191d` |
| canvas | `#121317` | `#121317` |
| TopBar vs canvas | 1.1967 | **1.0569** |
| Purple at the peak (x=150, y=4) | `#36314a`, B−R 20 | `#312b45`, B−R 20 |
| TopBar base purple (no ambient) | B−R 8 | B−R 5 |

The purple is unchanged at the peak while the bar's own surface has become almost
neutral, so the ambient's contribution is now 15 B−R points against a 5-point base —
the atmosphere comes from the light rather than from the band.

`npm run typecheck` 0 · `npm run test` 52 files / 1205 tests · `npm run build` pass ·
`cargo test` 145.
