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
| Surfaces | `--surface-editor:var(--color-bg)`, `--surface-sidebar` 94% raised→transparent, `--surface-tab-strip` 88% raised→base, `--surface-tab` 78% raised→base, `--surface-tab-hover` 94% tab→6% text, `--surface-tab-active` 89% tab→11% text, `--border-tab` 84% border→transparent, `--border-tab-hover` 92% border→8% text, `--border-tab-active` 58% accent→border, `--highlight-tab:rgb(255 255 255 / 5%)`, `--surface-tree-hover` 5% text→transparent, `--surface-tree-selected` 72% selection→raised, `--color-tree-guide` 18% muted→transparent |
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
| FR-041, FR-047 | 1px guides on `--color-tree-guide`, measured visible (1.43:1) but below the label hierarchy |
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
