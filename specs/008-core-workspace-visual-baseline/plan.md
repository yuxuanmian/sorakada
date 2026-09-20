# Implementation Plan: Core Workspace Visual Baseline — Dark

**Branch**: `feature-core` | **Feature ID**: `008-core-workspace-visual-baseline` | **Date**: 2026-09-20 | **Spec**: `specs/008-core-workspace-visual-baseline/spec.md`

**Input**: Feature specification from `/specs/008-core-workspace-visual-baseline/spec.md`

**Implementation Baseline**: `feature-core` @ `c246ea824aa3b878556d245076ca23c6f362d15f` (`feat(ui): 完成 007 桌面 UI 结构基础`)

## Summary

008 is a presentation-only follow-up to 007. It turns the existing structural shell into Sorakada's first reviewed Dark workspace visual baseline without changing document/Workspace behavior or introducing a Theme/Settings subsystem.

The implementation deliberately reuses 007's seams:

- central semantic tokens in `src/styles/global.css`;
- structural density tokens mirrored by `src/styles/density.css` and `src/app/shell/density.ts`;
- one `EditorGroup` / one live CodeMirror `EditorView`;
- CodeMirror's existing application-level `appearanceCompartment`;
- the current measured `TabStrip` and `tabLayout.ts` solver;
- the flattened/virtualized `ExplorerVirtualTree` + `ExplorerRow` split;
- `UiIconProvider` / `FileIconProvider` rather than file-name branches in Tree rows;
- existing 10,000-row and 100-Tab development fixtures.

The technical approach is intentionally CSS/token-heavy. React/domain code changes are limited to the minimal filesystem-icon draw-mode extension required by FR-048; all other desired visual contracts use existing markup and presentation seams. No new runtime dependency, Rust change, IPC change, Tauri configuration change, or business-state owner is planned.

## Technical Context

**Language/Version**: TypeScript ~6.0.3, React 19.1, CSS; Rust backend remains unchanged

**Primary Dependencies**: CodeMirror 6, `@tanstack/react-virtual` 3.14.13, existing Sorakada UI layer; no new runtime dependency planned

**Storage**: Existing `UiPreferences` only; 008 adds no appearance persistence

**Testing**: Vitest 4.1, existing static CSS/source audits, existing Explorer/Tab fixture tests, manual Tauri/WebView2 visual acceptance

**Target Platform**: Windows 10/11 Tauri 2 + WebView2; browser-only Vite remains a supported development fallback

**Project Type**: Desktop text/code editor

**Performance Goals**:
- keep 007's 10,000-row virtualized Tree mounted-count bound and correct offsets;
- keep 007's 100-Tab one-row width/reveal behavior unchanged;
- scrollbar hover/drag must produce zero scrollport/layout-width shift;
- UI-only styling must add zero filesystem reads and zero document-text mirrors;
- short transitions must not affect editor input/caret/selection latency.

**Constraints**:
- no Theme Engine / Light theme / Settings / Search / syntax highlighting;
- no real transparent Tauri window, Acrylic/Mica, `backdrop-filter`, or blur stack;
- no component-local palette literals outside `src/styles/global.css`;
- no new `DocumentSession`/Explorer/Workspace visual state;
- no new file-extension icon mapping;
- no changes to popup/dialog/context-menu geometry in 008;
- no CSS geometry change that invalidates `tabLayout.ts` or virtualized Tree metrics.

**Scale/Scope**: Editor + TabStrip/Tabs + Explorer/Tree + those surfaces' scrollbars; validate with 100 Tabs and 10,000 visible Explorer rows at Compact/Default/Comfortable density.

## Constitution Check

*GATE: Must pass before implementation and be re-checked after design.*

### I. User Data Is Inviolable — PASS

008 does not change read/write/save/Save As/dirty/external-change logic. No visual task may touch saved-baseline transitions or unsaved-work guards. Manual close/save behavior is regression-only.

### II. State Has One Owner — PASS

- CodeMirror continues to own live text/selection/history.
- `DocumentManager`/`WorkContextManager`/`ExplorerController` remain unchanged owners.
- Appearance remains application presentation. Font/palette/radius/scrollbar values are CSS/application defaults, never document state.
- No new Theme store is introduced.

### III. Contracts Are Verified From Both Sides — PASS

No IPC contract changes are planned. Frontend visual contracts receive focused tests/static audits, while the standard Rust test gate remains mandatory to prove the backend stayed unaffected.

### IV. Commands Have One Execution Path — PASS

008 introduces no new user-visible command. Existing click/open/close/rename/new/save behavior is preserved; styling must not create new handlers.

### V. Scope and Complexity Must Be Earned — PASS

No new dependency, Theme framework, animation library, custom scrollbar library, font package, icon library, or settings subsystem is justified. CSS + existing seams are sufficient.

## Code-Aware Baseline Findings

### Existing token boundary

`src/styles/global.css` is already the only approved palette-literal file, enforced by `src/ui/cssContract.test.ts`. 008 MUST extend this contract instead of creating a second theme file with hard-coded colors.

Current application structural style files already separate concerns:

```text
src/styles/global.css    # palette/typography/shared tokens
src/styles/density.css   # density-controlled geometry
src/styles/shell.css     # shell regions
src/styles/tabs.css      # TabStrip/Tab
src/styles/explorer.css  # Explorer/Tree
src/styles/editor.css    # CodeMirror host only today
src/ui/ui.css            # popup primitives; not an 008 redesign target
```

### Existing Editor appearance seam

`src/editor/editorConfig.ts` already installs the CodeMirror theme through one `appearanceCompartment` and exposes `reconfigureAppearance()`. 008 MUST reuse it. There is no need for an `EditorAppearanceStore`, Settings schema, or per-document theme field.

### Existing Tab geometry seam

`TabStrip.tsx` assigns exact widths from `tabLayout.ts`. Offsets/reveal arithmetic sums those widths and does **not** account for a new CSS `gap` or Tab margins. Therefore 008's frame must be drawn **inside the existing logical Tab box**, preferably with a pseudo-element/decorative layer. Do not add horizontal margins or `gap` between `.tab` boxes.

### Existing Explorer geometry seam

`ExplorerVirtualTree` uses density-derived fixed row heights and a materialized-row horizontal extent. `ExplorerRow` already owns Tree guide markup. 008 can change row visual composition, but fixed height and depth metrics must remain synchronized with `density.ts`.

The current `.explorer-row` background spans the row box. 008 replaces only that presentation with a depth-independent inset feedback layer; selection, expansion, focus, virtual identity and filesystem state stay where they are.

### Existing icon seam

`FileIconProvider` already resolves only `file`, `folder`, `folder-open`, `other`, and `link` fallbacks and explicitly forbids file-content reads/special-name logic. Implement the required filled generic primary glyphs by extending `IconDescriptor` only with the minimal provider-neutral renderer metadata; do not create an icon-theme subsystem.

## Design Decisions

### 1. Frozen Dark baseline palette

008's first implementation MUST use the following base values in `src/styles/global.css`. These are implementation defaults for this milestone, not a permanent public theme API.

| Token | 008 baseline |
|---|---|
| `--color-bg` | `#1b1c1f` |
| `--color-bg-raised` | `#22242a` |
| `--color-border` | `#343740` |
| `--color-text` | `#e3e5e8` |
| `--color-text-muted` | `#aeb3ba` |
| `--color-text-subtle` | `#747a83` |
| `--color-line-active` | `#292c33` |
| `--color-selection` | `#3a4555` |
| `--color-selection-text` | `#eef1f4` |
| `--color-accent` | `#4a8cff` |
| `--color-caret` | `#82aaff` |
| `--color-hover` | `#272a30` |
| `--color-active` | `#30343c` |
| `--color-focus-ring` | `#4f83c5` |
| `--color-danger` | retain `#b0403a` unless contrast acceptance proves it unreadable |

The important constraints are the relative hierarchy and low saturation. An implementation agent MUST use these values for the first 008 pass and MUST NOT substitute a personal palette.

### 2. Frozen derived surface tokens

Add semantic derived variables in `global.css`; components consume these instead of reconstructing mixes independently.

```css
--surface-editor: var(--color-bg);
--surface-sidebar: color-mix(in srgb, var(--color-bg-raised) 94%, transparent);
--surface-tab-strip: color-mix(in srgb, var(--color-bg-raised) 88%, var(--color-bg));
--surface-tab: color-mix(in srgb, var(--color-bg-raised) 78%, var(--color-bg));
--surface-tab-hover: color-mix(in srgb, var(--surface-tab) 94%, var(--color-text) 6%);
--surface-tab-active: color-mix(in srgb, var(--surface-tab) 89%, var(--color-text) 11%);
--border-tab: color-mix(in srgb, var(--color-border) 84%, transparent);
--border-tab-hover: color-mix(in srgb, var(--color-border) 92%, var(--color-text) 8%);
--border-tab-active: color-mix(in srgb, var(--color-accent) 58%, var(--color-border));
--highlight-tab: rgb(255 255 255 / 5%);
--surface-tree-hover: color-mix(in srgb, var(--color-text) 5%, transparent);
--surface-tree-selected: color-mix(in srgb, var(--color-selection) 72%, var(--color-bg-raised));
--color-tree-guide: color-mix(in srgb, var(--color-text-muted) 13%, transparent);
--scrollbar-thumb: rgb(174 179 186 / 28%);
--scrollbar-thumb-hover: rgb(174 179 186 / 45%);
--scrollbar-thumb-active: rgb(174 179 186 / 62%);
```

`rgb(...)` literals remain legal because they are in the approved central token file.

No component may create a competing `#...` / `rgb(...)` value for 008 visuals.

### 3. Material strategy: internal only

008 gives Sidebar/Tab chrome a slight material impression through alpha/gradient layers over the application's existing opaque base. It does **not** make the native window transparent.

Forbidden in 008:

- changing `src-tauri/tauri.conf.json` transparency/backdrop settings;
- Acrylic/Mica APIs;
- `backdrop-filter` / large blur filters;
- desktop wallpaper visibility through the Editor;
- per-panel heavy drop shadows.

`src/styles/shell.css` may switch `.sidebar` to `--surface-sidebar`. `tabs.css` may switch the strip to `--surface-tab-strip`. Editor uses `--surface-editor`. TopBar/Footer/EmptyState are not independently redesigned.

### 4. Editor appearance defaults

Keep general UI typography separate from Editor typography. Add/retain the following central application defaults:

```css
--font-editor: "JetBrains Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC",
  "Microsoft YaHei UI", ui-monospace, monospace;
--font-size-editor: 14px;
--editor-line-height: 1.52;
--editor-padding-block: 10px;
--editor-line-padding-inline: 8px;
```

Rules:

- do not download/bundle JetBrains Mono in 008;
- do not reuse the future Editor font choice as a document field;
- keep `--font-ui` unchanged;
- `--font-mono` used by debug/utility UI may remain independent;
- future Settings can replace these application appearance variables/reconfigure the existing appearance compartment.

`editorConfig.ts` should consume the variables instead of embedding `lineHeight: "1.6"` or raw padding.

### 5. Editor state hierarchy

CodeMirror visual priority:

```text
selection > current line > editor base
```

Implementation baseline:

- `.cm-activeLine`: `color-mix(in srgb, var(--color-line-active) 72%, transparent)`; keep enough transparency that CodeMirror's drawn-selection layer remains visible beneath the line element.
- `.cm-activeLineGutter`: same family, current line number `var(--color-text)`.
- focused drawn selection and native selection: `var(--color-selection)`.
- native `::selection` may set `color: var(--color-selection-text)`.
- because 008 has no syntax highlighting, do **not** build a brittle CodeMirror overlay solely to recolor every drawn-selection glyph. The semantic `--color-selection-text` token is the contract future syntax work will consume.
- caret remains 2px and `var(--color-caret)`.

Manual acceptance must compare selection on/off the current line and reject any combination where the selection becomes ambiguous.

### 6. Gutter

008 only tones the existing gutter:

- same `--surface-editor` family as content;
- ordinary line number `--color-text-subtle`/muted hierarchy;
- active line number `--color-text`;
- no strong vertical divider;
- no reserved width for future breakpoint/diagnostic/VCS icons;
- no new functional gutter icon.

### 7. Tab frame geometry: do not alter the solver

Keep all 007 density Tab height/min/max values unchanged.

`.tab` remains the measured logical box. Draw visual material inside it:

```text
logical Tab width from tabLayout.ts
┌──────────────────────────────┐
│  1px horizontal inset       │
│  ┌ framed visual surface ┐   │
│  └───────────────────────┘   │
└──────────────────────────────┘
```

Baseline CSS geometry:

- `.tab { position: relative; background: transparent; border: 0; }`
- `.tab::before` is decorative and non-interactive.
- frame inset: top `2px`, left/right `1px`, bottom `1px`.
- frame border: `1px solid var(--border-tab)`.
- frame radius: `var(--radius-md)` (current 5px baseline).
- inactive surface: `var(--surface-tab)`.
- hover: `var(--surface-tab-hover)` and `var(--border-tab-hover)`.
- active: `var(--surface-tab-active)`, `var(--border-tab-active)`, plus a very subtle `inset 0 1px 0 var(--highlight-tab)` / equivalent top highlight.
- background MAY use a small vertical gradient, but only between the frozen tab surface/highlight tokens; no new literal colors.
- `.tab > *` remains above the decorative layer.
- no `.tab` horizontal margin and no `gap` on the document viewport.

This creates the requested individual outline while preserving `tabOffsets()` arithmetic exactly.

### 8. Tab states

- Inactive: frame always visible but quiet.
- Hover: surface/frame slightly stronger; no translation/scale.
- Active: clear frame/surface + restrained accent border, no thick glow.
- Dirty/external markers: existing semantics/colors remain readable; do not invent a new marker design in 008.
- Close: fixed current 18×18 hit box; may gain small-radius hover surface but cannot move.
- Fixed New/Overview: remain controls, not fake document Tabs; consume the same palette and small-radius hover language.

### 9. Explorer density values

Only Tree row height changes in the 007 two-sided density contract:

| Density | 007 | 008 |
|---|---:|---:|
| Compact | 20px | **20px** |
| Default | 22px | **24px** |
| Comfortable | 26px | **28px** |

Keep existing Tree indent and chevron sizes:

- Compact: indent 12px / chevron 14px
- Default: indent 14px / chevron 16px
- Comfortable: indent 18px / chevron 18px

Keep Tab/menu/control/TopBar/Footer density metrics unchanged.

Update both `density.css` and `density.ts` in the same task group; `density.test.ts` remains the two-sided contract.

### 10. Explorer feedback geometry

Do not set hover/selection background directly on `.explorer-row`.

Use one decorative feedback layer (pseudo-element is preferred) whose geometry is independent of row depth:

```css
.explorer-row {
  position: relative;
  isolation: isolate;
  background: transparent;
}

.explorer-row::before {
  content: "";
  position: absolute;
  top: 1px;
  bottom: 1px;
  left: calc(var(--tree-indent) / 2 + 1px);
  right: calc(var(--tree-indent) / 2 + 1px);
  border-radius: var(--radius-md);
  pointer-events: none;
  /* actual colors come from semantic states */
}
```

The exact stacking implementation may use `z-index` only through existing named layers or local stacking without new global z-index magic. Direct row children/guides must stay above the feedback layer.

State colors:

- hover: `--surface-tree-hover`;
- selected (including selected+hover): `--surface-tree-selected`;
- selected text/icon: primary text hierarchy;
- ordinary icon/text: muted hierarchy.

The `left/right` formula is constant for every row in a given density. It MUST NOT include `row.depth` or inline depth styles.

For horizontally overflowing materialized content, the first 008 implementation may let the far rounded right edge move outside the viewport with the content layer, but the feedback surface MUST remain visibly present across the unscrolled viewport. Do not build a custom sticky-selection overlay just to keep both rounded corners in view; that complexity is not earned by 008.

### 11. Explorer guides

Keep current flat guide-slot rendering. Restyle only:

- 1px line remains;
- color becomes `--color-tree-guide`;
- guides stay visible over feedback surfaces through local stacking;
- no glow, gradient or active-scope emphasis in 008.

Important terminology guard: this is **Explorer Tree hierarchy**, not Editor code indentation guides.

### 12. Generic filled filesystem icons

No icon library is added. Extend the existing renderer minimally to implement the required generic filled draw mode:

- add optional provider-neutral draw mode to `IconDescriptor`, e.g. `drawMode?: "stroke" | "fill"`;
- default remains `stroke`, so all existing UI action icons remain untouched;
- `defaultFileIconProvider` returns `fill` for primary generic filesystem fallback glyphs (`file`, `folder`, `folder-open`, `other`);
- the `link` badge remains stroke-oriented so it stays legible over a filled primary glyph;
- filled mode may render `fill="currentColor"` with a light current-color stroke if the existing open-path artwork needs edge definition;
- no filename/extension/language branch is added;
- no new file-type color palette is added.

If the current generic paths look unacceptable in fill mode, only the five generic fallback glyph paths may be adjusted; do not expand the icon vocabulary.

### 13. Inline Explorer input

Keep current behavior/DOM. Style with:

- height still `calc(var(--tree-row-height) - 4px)`;
- small `var(--radius-sm)`/`--radius-md` class consistent with Tree feedback;
- `--surface-editor`/base dark input surface;
- visible 1px focus border using `--color-focus-ring`;
- no animation that obscures Enter/Escape/blur behavior.

### 14. Scrollbar contract

Apply the same tokenized scrollbar appearance to:

- CodeMirror `.cm-scroller`;
- `.explorer__body`;
- `.tab-strip__viewport` when it horizontally overflows.

WebView2/Chromium baseline:

```css
::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

::-webkit-scrollbar-track,
::-webkit-scrollbar-corner {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  background-clip: content-box;
  border: 3px solid transparent; /* 12 - 6 = 2*3 => ~6px visual */
  border-radius: 999px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
  background-clip: content-box;
  border-width: 2px; /* ~8px visual */
}

::-webkit-scrollbar-thumb:active {
  background: var(--scrollbar-thumb-active);
  background-clip: content-box;
  border-width: 2px;
}
```

The 12px lane never changes, which guarantees no content shift. The transparent border is part of the thumb box and therefore preserves a larger hit area than the visible colored core.

Also set standards fallback where applicable:

```css
scrollbar-width: thin;
scrollbar-color: var(--scrollbar-thumb) transparent;
```

No JavaScript scrollbar package, custom drag controller or overlay scroll emulation.

### 15. Motion

Add only short background/border/opacity transitions on chrome states, using one central token such as:

```css
--motion-fast: 120ms;
```

Do not animate:

- Tab geometry/position/width;
- Tree row position/height;
- Editor text/caret/selection;
- scrollbar lane width;
- virtualizer transforms.

If a scrollbar pseudo-element does not reliably animate in WebView2, state change without transition is acceptable; geometry correctness is more important than animation.

### 16. Non-target surfaces

Do not redesign these files/surfaces as part of 008:

- `src/ui/ui.css` Menu/ContextMenu/Popover geometry/material;
- TopBar/window controls beyond inherited central palette;
- Footer geometry/content;
- Empty State composition;
- dialogs/native error surfaces;
- Tab Overview popup geometry (it may inherit colors; do not restyle as a new product surface).

If a global palette change causes contrast to fail on a non-target surface, first fix the central token hierarchy. Do not opportunistically redesign that surface.

## Post-Design Constitution Check

*GATE: Re-checked after the complete design decisions above, as required by the constitution.*

- **I. User Data Is Inviolable — PASS**: The final design remains presentation-only and introduces no read/write, saved-baseline, Save As, dirty-guard, or external-change path.
- **II. State Has One Owner — PASS**: CodeMirror and the existing application managers retain ownership; the required icon draw mode is provider-owned presentation metadata, and no document, Workspace, Explorer, or persisted preference model gains visual state.
- **III. Contracts Are Verified From Both Sides — PASS**: No IPC contract changes exist. Frontend token/geometry/source audits and behavior regressions cover the affected boundaries, while the unchanged Rust side remains protected by the mandatory `cargo test` gate.
- **IV. Commands Have One Execution Path — PASS**: The final design adds no command or handler and preserves all established interaction paths.
- **V. Scope and Complexity Must Be Earned — PASS**: The final design uses existing CSS, CodeMirror, icon-provider, Tab, and Explorer seams; it adds no runtime dependency, Theme/Settings system, custom scrollbar, backend work, or unrelated redesign.

## Project Structure

### Documentation (this feature)

```text
specs/008-core-workspace-visual-baseline/
├── spec.md
├── plan.md
└── tasks.md
```

No `research.md`, `data-model.md` or new IPC contract is required because 008 introduces no new domain entity, persistence model or backend contract.

### Source Code (expected touch points)

```text
src/
├── styles/
│   ├── global.css                 # Dark palette, semantic surfaces, editor/scrollbar/motion tokens
│   ├── density.css                # Tree row-height adjustments only
│   ├── editor.css                 # host / scrollbar styling if CSS-side is used
│   ├── tabs.css                   # framed Tab surfaces + Tab scrollbar
│   ├── explorer.css               # stable feedback layer, guides, inline input + Tree scrollbar
│   └── shell.css                  # Sidebar surface token only; no shell redesign
├── editor/
│   ├── editorConfig.ts            # CodeMirror typography/current-line/selection/gutter styling
│   └── editorConfig.test.ts       # appearance/default regression checks
├── app/
│   ├── shell/
│   │   ├── density.ts             # synchronize 20/24/28 Tree row heights
│   │   └── density.test.ts
│   ├── tabs/
│   │   ├── TabStrip.tsx           # ideally no structural change
│   │   ├── tabLayout.ts           # MUST remain behaviorally unchanged
│   │   └── existing tests + visual source contract test
│   ├── explorer/
│   │   ├── ExplorerRow.tsx        # only if icon draw mode/styling needs class/attribute support
│   │   ├── ExplorerVirtualTree.tsx# no behavior change expected
│   │   └── existing regression tests + visual contract test
│   ├── icons/
│   │   ├── iconTypes.ts           # optional minimal drawMode extension
│   │   ├── fileIconProvider.ts    # generic fill mode only
│   │   ├── glyphs.ts              # generic fallback artwork only if required
│   │   └── icons.test.ts
│   └── performance/
│       ├── treeFixtures.ts         # reuse, do not duplicate
│       └── tabFixtures.ts          # reuse, do not duplicate
└── ui/
    └── cssContract.test.ts         # extend audit if needed; ui.css itself is not redesigned
```

`src-tauri/**` is not an expected touch point. Any proposed 008 change there is a stop-and-review condition.

**Structure Decision**: Keep 007's presentation architecture. 008 adds no new top-level feature/service/store subsystem. Visual values remain central CSS/application appearance, not React business state.

## Testing Strategy

### Automated visual-contract tests

Aesthetic quality cannot be proven by unit tests, but the implementation boundaries can be pinned so an implementation model cannot quietly replace the approved design.

Add a focused `src/styles/visualBaseline.test.ts` (or equivalent) using raw CSS/source inventory to assert at least:

1. the frozen base tokens and required semantic token names exist in `global.css`;
2. `--font-editor` starts with JetBrains Mono and contains at least one CJK/system fallback;
3. `--editor-line-height`, padding, scrollbar lane/idle/hover tokens exist;
4. no `backdrop-filter` appears in 008-owned CSS and no production frontend/config file introduces a Tauri-transparent, Acrylic, Mica, or native-backdrop API/config hook; tests, specifications, documentation, and comments are excluded from literal-string matching;
5. `.tab::before`/equivalent framed layer exists and Tabs do not gain horizontal margins / document-viewport gap;
6. Explorer feedback geometry uses a depth-independent left/right expression and not a `depth`-derived inline width;
7. existing CSS audit still reports no palette literal outside `global.css`.

Do not turn tests into screenshots or pixel-perfect browser rendering tests in 008; the repository does not currently own that harness.

### Existing behavior tests to rerun

- `src/app/tabs/tabStrip.test.ts`
- `src/app/tabs/tabPresentationBoundary.test.ts`
- `src/app/explorer/explorerVirtualRegression.test.ts`
- `src/app/explorer/explorerTreeMetrics.test.ts`
- Explorer click/action/controller/reconciliation suites
- `src/app/icons/icons.test.ts`
- `src/app/shell/density.test.ts`
- `src/editor/editorConfig.test.ts`
- full `npm run test`

### Manual acceptance matrix

Use a real Tauri/WebView2 session for final visual acceptance. The implementation model must record PASS/FAIL notes; maintainer visual review remains authoritative for aesthetic acceptance.

#### Editor matrix

At Default density with a mixed English/CJK document:

- ordinary line;
- current line;
- selected text away from current line;
- selection crossing current line;
- multi-line selection;
- vertical overflow;
- horizontal overflow;
- both scrollbars present.

Verify:

- neutral deep-gray plane, softened near-white text;
- JetBrains Mono preferred when available and CJK fallback readable;
- current line/current line number visible;
- selection stronger than current line;
- no scrollbar-induced layout shift;
- no fake syntax colors/Editor indent guides.

#### Tab matrix

Use real documents plus the existing 100-Tab fixture:

- inactive, hover, active;
- active+dirty;
- modified/missing external markers;
- close hover;
- min-width overflow;
- first/middle/last active reveal;
- fixed New/Overview;
- Compact/Default/Comfortable density.

Reject:

- borderless flat appearance;
- pill/large-card feel;
- heavy glow/shadow;
- label movement on hover;
- offset/reveal mismatch caused by CSS geometry.

#### Explorer matrix

Use real Workspace and 10,000-row fixture:

- depth 0/1/5/10+ rows;
- hover and selected at each depth;
- loading/error/cycle sentinel;
- inline New and Rename;
- symlink/junction badge;
- long/deep horizontal overflow;
- Compact/Default/Comfortable density;
- virtual scroll top-to-bottom.

Reject:

- feedback surface that gets shorter with depth;
- selected surface flush to whole Sidebar edge;
- guides disappearing or becoming visually dominant;
- selection hidden until horizontal scroll;
- row overlap after 24/28px density update;
- icon resolver adding extension/language behavior.

#### Cross-region matrix

At 640×400, 1200×780 and a large 2160p/1080p display setup where available:

- compare Sidebar/TabStrip/Editor surface hierarchy;
- verify no region looks like a separate unrelated theme;
- verify TopBar/Footer/popups remain structurally unchanged;
- verify no desktop content is visible through the Editor.

## No-Freestyle Implementation Rule

This is especially important for 008 because visual work is easy for an implementation model to reinterpret.

The implementation agent MUST treat the token values, row heights, Tab frame geometry, Tree feedback geometry, font stack, scrollbar geometry, state hierarchy, and deferred list in this plan as **frozen first-pass decisions**.

The agent MUST NOT, without maintainer approval:

- choose a different palette “because it looks better”;
- replace framed Tabs with underline-only Tabs;
- turn Tabs/Tree rows into large cards/pills;
- add gradients/highlights beyond the frozen restrained use;
- add shadows/glass/blur/backdrop effects not named here;
- add a font/icon/animation/UI dependency;
- add language file icons or syntax highlighting;
- restyle dialogs/menus/TopBar/Footer as bonus work;
- move appearance into persistent preferences or document state;
- change Tree/Tab interaction behavior while touching their CSS;
- adjust `tabLayout.ts` to compensate for decorative CSS that should not have changed geometry.

If the first implementation looks wrong in real use, the correct workflow is: implement this baseline exactly → visually review → create explicit follow-up corrections. Do not silently improvise during implementation.

## Quality Gates and Completion

Before reporting 008 complete:

1. `npm run typecheck`
2. `npm run test`
3. `npm run build`
4. `cargo test` from `src-tauri`
5. Run the Editor/Tab/Explorer/Scrollbar manual acceptance matrix above.
6. Compare against the 007 post-implementation baseline screenshots/notes captured by T225 where available.
7. Perform a final source audit confirming no Rust/Tauri/config/dependency/business-state scope leak.

## Complexity Tracking

No Constitution exception is planned.

| Potential complexity | Decision |
|---|---|
| Full Theme Engine | Rejected; one Dark baseline only |
| Windows Acrylic/Mica | Rejected; in-app material only |
| Custom JS scrollbar | Rejected; CSS/WebView2 native scrollbar styling |
| Font package/bundling | Rejected; JetBrains Mono preference + fallback stack |
| Icon library/theme | Rejected; minimal existing-provider draw-mode extension only |
| New visual state store | Rejected; CSS/application appearance boundaries already exist |
| Screenshot test framework | Rejected for 008; manual visual acceptance + static contract tests |
