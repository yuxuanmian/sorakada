# Feature Specification: Core Workspace Visual Baseline — Dark

**Feature Branch**: `feature-core` (008 remains the feature/document identifier; implementation continues on the shared `feature-core` branch)

**Created**: 2026-09-20

**Status**: Ready for implementation — product direction frozen after 007 code-aware review

**Input**: Turn 007's structural UI foundation into Sorakada's first stable product-facing Dark workspace baseline. Refine only the core editing surfaces — Editor, TabStrip/Tabs, and Explorer/Tree — so they share one calm material language while preserving every established document, Workspace, virtualization, watcher, command, and accessibility contract. Search/Replace moves to 009; dialogs/popups, Light theme, Settings, syntax highlighting, language-specific editor guides, and the final icon/theme systems remain deferred.

**Implementation Baseline**: `feature-core` at commit `c246ea824aa3b878556d245076ca23c6f362d15f` (`feat(ui): 完成 007 桌面 UI 结构基础`). 008 builds directly on the completed 001–007 implementation and MUST treat 007's layout/state/interaction contracts as authoritative unless this specification explicitly supersedes a presentation-only contract.

## Product Intent

007 proved that Sorakada can host a custom AppShell, one EditorGroup, a virtualized Explorer, scalable one-row Tabs, UI preferences, and Sorakada-owned UI primitives. 008 is deliberately narrower: it makes the core workspace look and feel like one product instead of a structural prototype.

The first visual baseline is **Dark-first**. It is not the final Theme System and not an invitation to redesign every existing surface. The primary visual field is the area users look at while editing code:

```text
Sidebar / Explorer | TabStrip
                   | Editor
```

The three regions MUST share one visual language. They MAY differ in information density and material strength, but they MUST NOT look like three unrelated component libraries.

The intended baseline is:

> low-transparency, soft material chrome + a stable near-opaque editor reading plane + restrained contrast + explicit interaction feedback.

The Editor is the quietest surface. Explorer carries the most structural information. Tabs sit between them: visually distinct enough to remain legible when crowded, but still integrated with the Editor rather than floating as independent cards.

008 is intentionally iterative. It establishes a coherent first baseline with frozen implementation defaults; later visual milestones MAY tune those defaults after real use. Implementation agents MUST NOT reinterpret that flexibility as permission to invent an alternative visual direction during 008.

## Design Lock

The following decisions are product decisions, not implementation suggestions:

- Dark is the only theme receiving deliberate visual polish in 008.
- The main Editor background MUST be a soft neutral deep gray, not pure black and not strongly blue-black.
- Main text MAY approach white but MUST be softened rather than pure `#fff` as the default reading color.
- Real Windows Acrylic/Mica, transparent-window configuration, heavy blur, and desktop-background bleed-through are deferred. 008's material impression is created inside the existing opaque application surface.
- Tabs MUST have visible individual frames. 008 MUST NOT replace them with a borderless flat strip.
- Tab frames use small radii, subtle highlight/gradient and restrained accent. They MUST NOT become pill controls, thick cards, or heavy 3D buttons.
- Explorer hover/selection feedback uses a small-radius **stable-width interaction surface**. Its width MUST NOT shrink as node depth increases.
- Explorer depth continues to be communicated by content indentation and thin Tree guides, not by shortening the hover/selection surface.
- Editor current-line feedback is visible but weaker than selection. The current line number is highlighted with it.
- The selection state visually dominates the current-line state.
- JetBrains Mono is the preferred default Editor font family, with practical CJK/system fallbacks. 008 does not bundle a font or create Settings.
- Editor font family, font size, line height, and content padding are defaults only. Their implementation MUST preserve an application-level seam for future Settings; they MUST NOT become document state.
- Editor syntax highlighting and Editor indentation/structure guides are NOT part of 008. Explorer Tree guides remain in scope because they already exist and are part of the file-tree presentation.
- Scrollbars use a quiet thin visual thumb inside a permanently wider hit lane. Hover/drag MAY visually widen/brighten the thumb without changing the layout or pushing content.
- Dialogs, Context Menu visual redesign, Tooltip redesign, Footer redesign, Settings, Search/Replace, and a full file-icon theme are outside 008.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read and Edit Comfortably in the Dark Editor (Priority: P1)

A programmer spends long periods reading and editing text in Sorakada. The Editor should be calm, legible and clearly interactive without the harsh contrast of pure black/pure white or the visual noise of IDE-specific decorations.

**Why this priority**: The Editor is the primary work surface and the most sensitive area for prolonged visual comfort. Visual polish elsewhere is secondary if code/text remains tiring to read.

**Independent Test**: Open a mixed English/Chinese text file, move the caret through several lines, create single-line and multi-line selections including the current line, scroll vertically/horizontally, and verify the Editor remains readable and stable with no layout shift or hidden selection.

**Acceptance Scenarios**:

1. **Given** an active document, **When** the Editor renders, **Then** its reading plane is near-opaque neutral dark gray and does not expose desktop/window content behind the text.
2. **Given** ordinary text, **When** it is rendered, **Then** the default foreground is a softened near-white with sufficient contrast against the Editor background and is not pure white by default.
3. **Given** JetBrains Mono is installed, **When** the Editor renders Latin/code characters, **Then** JetBrains Mono is the first-choice family.
4. **Given** JetBrains Mono lacks a glyph or is unavailable, **When** Chinese/CJK or unsupported characters render, **Then** a defined fallback stack produces readable glyphs without tofu boxes caused by the styling contract.
5. **Given** the caret changes lines, **When** the active line moves, **Then** the full current line receives a noticeable but restrained background change and the corresponding line number becomes more prominent.
6. **Given** text is selected on either the current line or another line, **When** the selection is rendered, **Then** selection is more visually prominent than current-line feedback and remains clearly identifiable in both locations.
7. **Given** future syntax colors are later introduced, **When** the current 008 selection contract is extended, **Then** the architecture leaves room for a unified selection foreground rather than requiring every syntax token to remain colored inside the selection.
8. **Given** the Editor receives focus, **When** the user types or moves the caret, **Then** editing feedback remains immediate; 008 MUST NOT add animation latency to caret, selection or text updates.
9. **Given** no syntax language package is active, **When** 008 is complete, **Then** 008 MUST NOT fake syntax coloring or fake code-structure/indentation guides.

---

### User Story 2 - Distinguish and Operate Crowded Tabs Reliably (Priority: P1)

A programmer can keep many documents open and still perceive each Tab as a separate work label. The active Tab is clear, inactive Tabs remain legible, and hover/dirty/external/close states do not make the strip visually noisy or geometrically unstable.

**Why this priority**: Tabs are continuously visible and 007 already solved the behavior/overflow architecture. 008 must improve their visual identity without destabilizing the width solver or many-Tab behavior.

**Independent Test**: Use the existing 100-Tab development fixture, activate Tabs at both ends, hover and close Tabs, show dirty/external markers, resize the window, switch density, and verify every Tab remains framed, single-row, correctly measured and visually integrated with the Editor.

**Acceptance Scenarios**:

1. **Given** one or more Tabs, **When** they render, **Then** every document Tab has an individual visible frame with a small radius.
2. **Given** an inactive Tab, **When** it is idle, **Then** the frame/surface is subdued but still separable from adjacent Tabs.
3. **Given** an inactive Tab, **When** it is hovered, **Then** it receives a small brightness/material increase without changing its width, height, label position or close-button position.
4. **Given** an active Tab, **When** it renders, **Then** its surface and border are clearer than inactive Tabs and MAY use a restrained accent/highlight; it MUST NOT look like a thick floating card.
5. **Given** a dirty or external-state Tab, **When** the state marker appears, **Then** the marker remains visible at the 007 minimum-width behavior and the Tab frame does not reflow unexpectedly.
6. **Given** many Tabs overflow, **When** the document Tab viewport scrolls, **Then** the fixed New (`+`) / Overview action region remains outside the document scroll viewport exactly as in 007.
7. **Given** a Tab close button is idle or hovered, **When** its state changes, **Then** the close control stays in a stable 18px-class hit area and does not cause label or Tab width movement.
8. **Given** the 007 Tab width solver assigns widths, **When** 008 styling is applied, **Then** visual framing MUST NOT introduce CSS margins/gaps or other unmeasured geometry that invalidates `tabLayout.ts` offsets/reveal calculations.

---

### User Story 3 - Scan a Dense but Comfortable Explorer (Priority: P1)

A programmer browses project files through an Explorer that is slightly more comfortable than the 007 prototype while retaining enough information density for real source trees. Hierarchy remains visible, and interaction feedback is strong enough to see at any depth.

**Why this priority**: Explorer is the densest core surface and exercises virtualization, horizontal overflow, indentation guides, inline editing, icons, and selection at once. It is the best stress test of whether 007's UI seams are usable in real visual work.

**Independent Test**: Use shallow, deeply nested and 10,000-row fixtures; hover/select depth-0 and very deep rows; expand/collapse directories; horizontally scroll a long path; inline-create/rename; and verify stable feedback geometry, thin guides, readable icons and unchanged click/open semantics.

**Acceptance Scenarios**:

1. **Given** Default density, **When** ordinary Tree rows render, **Then** the row rhythm is slightly more spacious than 007's 22px Default baseline while remaining suitable for project navigation.
2. **Given** nested directories, **When** Tree guides render, **Then** guide lines remain one-pixel-class, low-contrast structural aids and never become a dominant visual grid.
3. **Given** rows at different depths, **When** each row is hovered, **Then** every hover surface uses the same left/right interaction band for the current Tree viewport/content band; the surface width does not shrink with row depth.
4. **Given** rows at different depths, **When** each row is selected, **Then** the selected surface uses the same stable horizontal band and small radius as hover, with stronger visual emphasis than hover.
5. **Given** a very deep node whose label begins far to the right, **When** the user has not horizontally scrolled, **Then** hover/selection feedback is still visibly present across the Tree area rather than existing only around the far-away label.
6. **Given** a node's depth changes only its structural position, **When** it renders, **Then** chevron/icon/text and guides follow depth, while the hover/selection surface geometry does not derive from depth.
7. **Given** a file or directory row, **When** its generic filesystem icon renders, **Then** the 008 baseline uses a restrained filled-style generic primary glyph while still resolving through the existing `FileIconProvider` contract.
8. **Given** special filenames such as `.gitignore`, `package.json`, `Cargo.toml`, `.java`, `.html` or `.dart`, **When** 008 renders them, **Then** 008 does not add special language/file-type icon mappings; those remain a later icon milestone.
9. **Given** inline New or Rename is active, **When** the input appears, **Then** it is clearly recognizable as an input control with a focused border/surface rather than disguised as ordinary Tree text.
10. **Given** existing file/directory click behavior, **When** 008 styling is applied, **Then** single-click selection, double-click open/toggle, chevron behavior, focus ownership, virtualization pinning and context targeting remain unchanged.

---

### User Story 4 - Scroll Without Visual Noise or Layout Shift (Priority: P2)

A programmer can scroll the Editor, Explorer and overflowing Tab viewport with controls that stay quiet when idle but become easier to see and grab when hovered or dragged.

**Why this priority**: The current browser-like scrollbars visually clash with the new workspace baseline. A scrollbar is both a visual surface and a high-frequency input target, so thin appearance cannot come at the cost of usability.

**Independent Test**: Create vertical and horizontal overflow in the Editor and Explorer plus horizontal overflow in the TabStrip, then hover and drag each scrollbar while watching the adjacent content bounds.

**Acceptance Scenarios**:

1. **Given** an idle scrollbar, **When** it is visible, **Then** its track is transparent or visually absent and the thumb is narrow, rounded and low-contrast.
2. **Given** the pointer enters the thumb, **When** hover styling applies, **Then** the visible thumb becomes modestly wider/brighter while the scrollbar lane itself remains the same width.
3. **Given** the user drags the thumb, **When** active styling applies, **Then** the thumb remains easy to see/grab and becomes stronger than hover without turning into a high-contrast native-looking bar.
4. **Given** idle, hover and dragging states, **When** they transition, **Then** Editor/Tree/Tab content geometry does not move horizontally or vertically because the interaction lane is fixed.
5. **Given** WebView2/Chromium renders custom scrollbar pseudo-elements, **When** the visual thumb is narrower than its lane, **Then** transparent thumb borders/background clipping or an equivalent fixed-lane method preserves the larger hit target.
6. **Given** a browser where the full WebKit styling is unavailable, **When** Sorakada runs in browser-only development mode, **Then** a safe thin-scrollbar fallback remains usable rather than breaking overflow.
7. **Given** 008 scrollbar work, **When** it is complete, **Then** it MUST NOT add minimap, search-hit, diagnostic, VCS or other semantic markers.

---

### User Story 5 - Keep One Visual Language Without Creating a Theme System (Priority: P2)

A programmer sees one coherent Dark workspace, while future Sorakada work can still add Settings, Light themes and richer appearance without storing visual choices in documents or rewriting the 007 architecture.

**Why this priority**: 008 is a baseline, not the final appearance subsystem. The feature is successful only if its visual choices remain centralized and replaceable.

**Independent Test**: Audit the final stylesheet/config sources and application state: all new palette literals are centralized, Editor appearance is application-level, 007 business-state models carry no new visual fields, and deferred surfaces received no independent redesign.

**Acceptance Scenarios**:

1. **Given** the final 008 CSS, **When** palette literals are audited, **Then** new literal colors exist only in the central token layer and feature styles consume semantic variables.
2. **Given** Editor font/size/line-height/padding defaults, **When** their ownership is inspected, **Then** they are application appearance defaults and not fields on `DocumentSession`.
3. **Given** the slight-material direction, **When** the implementation is inspected, **Then** 008 uses in-app layered surfaces only and does not change Tauri window transparency/decorations or introduce Acrylic/Mica/backdrop APIs.
4. **Given** App Menu, Context Menu, Popover, Footer and Empty State, **When** 008 is implemented, **Then** they receive at most the inherited central palette changes necessary for coherence; 008 does not redesign their geometry/material/interaction contracts.
5. **Given** Compact/Default/Comfortable density, **When** 008 changes Tree rhythm, **Then** the CSS and TypeScript density tables remain synchronized and virtualizer geometry remains correct.
6. **Given** existing document/Workspace/watch behavior, **When** 008 is complete, **Then** no filesystem I/O, document lifecycle, save/baseline, watcher, path identity, or command execution semantics have changed.

## Edge Cases

- JetBrains Mono is not installed on the machine.
- A document contains Chinese comments, emoji, uncommon Unicode, combining characters, or a mix of Latin/CJK glyphs.
- Selection spans the current line and non-current lines simultaneously.
- A multi-selection exists in CodeMirror.
- The current line is also selected.
- The user switches Compact/Default/Comfortable density while a 10,000-row Tree is mounted.
- A selected/hovered Explorer row is depth 0, depth 1, depth 10+, or far beyond the initial horizontal viewport.
- Explorer content is horizontally wider than the Sidebar and the user has not yet scrolled horizontally.
- Inline Rename/Create remains pinned by virtualization while the user scrolls.
- A Tree row is a loading/error/cycle sentinel rather than a normal entry.
- A row represents a symlink/junction and continues to display its existing badge/state.
- Tabs are zero, one, twenty, or one hundred; active Tab is at either overflow edge.
- Tab labels are shorter than minimum width, near maximum width, duplicated by basename, or heavily truncated.
- A Tab is active + dirty + external-modified/missing at the same time.
- The pointer crosses from Tab label to close control while hover styling changes.
- Editor, Explorer or TabStrip has no overflow and therefore no visible scrollbar.
- Both vertical and horizontal scrollbars are present at once; the lower-right intersection MUST NOT create a visually dominant browser-default block.
- Browser-only Vite mode does not implement the exact WebView2 scrollbar appearance.
- A narrow 640×400 supported window and ordinary 1200×780 window must both preserve 007 layout boundaries.
- The window moves between 1080p/2160p or different Windows scale factors; no physical-resolution-specific style branch is allowed.

## Requirements *(mandatory)*

### Visual Foundation

- **FR-001**: 008 MUST polish Dark appearance only. It MUST NOT implement a Light palette, automatic system-theme switching, a theme picker, or Theme Plugin API.
- **FR-002**: Editor, TabStrip/Tabs and Explorer/Tree MUST consume one central semantic Dark token vocabulary rather than define unrelated local palettes.
- **FR-003**: The Editor background MUST be a neutral soft deep gray and MUST NOT use pure black (`#000`, `#000000`) or a strongly saturated blue-black as the default reading plane.
- **FR-004**: Default primary Editor text MUST be a softened near-white rather than pure white (`#fff`, `#ffffff`).
- **FR-005**: 008 MUST retain a clear hierarchy among base, raised/chrome, hover, active/selected, border, muted text, primary text, focus/accent, and danger semantics.
- **FR-006**: New literal palette values MUST remain centralized in `src/styles/global.css`; component styles MUST consume tokens/derived semantic variables.
- **FR-007**: 008 MUST continue to satisfy the 007 CSS contract: no `!important`, deep-selector escape hatches, undocumented UI-library selectors, ad-hoc z-index values, or viewport-unit sizing of basic controls.
- **FR-008**: 008 MAY use alpha/color-mix/gradient inside application surfaces to create slight material depth, but MUST NOT enable transparent Tauri windows, Windows Acrylic/Mica, `backdrop-filter`-driven glass, or heavy blur.
- **FR-009**: UI chrome transitions MAY use a short approximately 100–150ms baseline, but usability MUST NOT depend on animation completion and Editor text/caret/selection updates MUST remain immediate.
- **FR-010**: Component-specific visual work is limited to Editor, TabStrip/Tabs, Explorer/Tree and their scrollbars. Other 007 surfaces keep their existing geometry and interaction styling unless an inherited central token change requires no component-specific redesign.

### Editor Appearance

- **FR-011**: The Editor's preferred default font stack MUST begin with `JetBrains Mono` and include practical CJK/system monospace fallbacks.
- **FR-012**: 008 MUST NOT add a font download, bundled font binary, font-serving dependency or font marketplace; unavailable fonts MUST fall back safely.
- **FR-013**: Editor font family, font size, line height and content padding MUST remain application appearance defaults rather than document/session state.
- **FR-014**: The existing application-level CodeMirror appearance reconfiguration boundary MUST remain usable for later Settings/Theme work; 008 MUST NOT replace it with per-document appearance state.
- **FR-015**: 008 MUST define one tuned default Editor preset around a 14 CSS-pixel Editor font and roughly 1.5–1.55 line height; exact implementation defaults are frozen by the implementation plan, not user-configurable in 008.
- **FR-016**: Editor content MUST have deliberate top/bottom and inline breathing room so the first text line does not visually collide with the TabStrip/gutter edges.
- **FR-017**: Gutter background MUST remain visually integrated with the Editor rather than becoming a strongly separate column.
- **FR-018**: Ordinary line numbers MUST be lower prominence than main text.
- **FR-019**: The active line number MUST become noticeably more prominent when the caret is on that line without changing line-number geometry.
- **FR-020**: The current line MUST use a visible but restrained full-line background treatment.
- **FR-021**: Selection MUST be visually stronger than current-line treatment and remain visible when selection intersects the current line.
- **FR-022**: 008 MUST define a semantic selection foreground token/contract suitable for future syntax-highlight selection normalization, even though 008 does not implement syntax coloring.
- **FR-023**: 008 MUST preserve current selection/caret/undo/history semantics and MUST NOT replace CodeMirror's live text/selection ownership with React state.
- **FR-024**: Caret styling MUST remain crisp and immediately visible against the new Editor background without becoming a broad animated cursor effect.
- **FR-025**: 008 MUST NOT implement syntax highlighting, language packages, Editor indentation guides, structural scope guides, minimap, ruler or semantic gutter icons.
- **FR-026**: Existing CodeMirror basic folding/bracket/selection behavior MAY retain its current functionality; 008 only aligns already-present visual elements with the new baseline where necessary.

### TabStrip and Tabs

- **FR-027**: Every document Tab MUST render a distinct small-radius frame independent of active state.
- **FR-028**: Tab frames MUST remain visually integrated with the EditorGroup and MUST NOT be styled as pills, large rounded cards or heavy detached glass buttons.
- **FR-029**: Inactive Tab frame/border/surface MUST be quieter than hover and active states while still defining the Tab boundary when many Tabs are adjacent.
- **FR-030**: Hover MUST increase Tab surface/frame prominence without altering measured Tab geometry.
- **FR-031**: Active Tab MUST be distinguished through a stronger surface/frame plus restrained accent/highlight, not through a large shadow or major height/position change.
- **FR-032**: Tabs MAY use a subtle top/edge highlight and a slight vertical gradient to produce material depth.
- **FR-033**: 008 Tab styling MUST preserve the width values computed by `tabLayout.ts`; CSS MUST NOT add unaccounted horizontal margins or viewport gaps between logical Tab boxes.
- **FR-034**: Tab content (label, dirty marker, external marker, close) MUST stay above any purely decorative frame layer and remain readable in inactive/hover/active states.
- **FR-035**: Dirty and external modified/missing markers MUST retain their existing semantics and minimum-width visibility.
- **FR-036**: Close button geometry MUST remain stable; hover styling MUST NOT cause label movement.
- **FR-037**: The fixed New (`+`) and Overview action region MUST remain behaviorally and geometrically outside the scrolling document Tab viewport as defined by 007.
- **FR-038**: 008 MUST NOT change Tab order, close behavior, active reveal, Overview filtering, Tab width solver, one-row overflow, `DocumentSession`, or single-EditorGroup ownership.

### Explorer and Tree

- **FR-039**: Default Explorer row rhythm MUST become slightly more spacious while retaining Compact/Default/Comfortable density semantics and project-navigation information density.
- **FR-040**: The implementation baseline MUST keep Compact the densest practical mode and increase the Default/Comfortable Tree row heights only by the plan's small frozen amount; 008 MUST NOT globally enlarge all controls to achieve comfort.
- **FR-041**: Explorer indentation guides MUST remain visible, thin and low-contrast; 008 MUST NOT remove the guide system established by 007.
- **FR-042**: Explorer hover feedback MUST render as a small-radius surface with stable horizontal bounds independent of node depth.
- **FR-043**: Explorer selected feedback MUST use the same stable horizontal geometry as hover and be visibly stronger than hover.
- **FR-044**: Depth MUST affect guides, chevron, icon and label indentation only; depth MUST NOT shorten the hover/selected surface.
- **FR-045**: The feedback surface's left boundary MUST begin just inside the root-guide/content-band region and its right boundary MUST preserve the corresponding visual inset so ordinary non-overflowing Tree rows appear horizontally balanced.
- **FR-046**: Deep rows MUST still show visible hover/selection feedback before the user horizontally scrolls to the label.
- **FR-047**: Guide lines MUST remain readable through hover/selection feedback without becoming brighter than the selected node label/icon.
- **FR-048**: 008 MUST render the generic primary filesystem glyphs (`file`, `folder`, `folder-open`, and `other`) in a restrained filled visual style through the existing icon provider/renderer boundary; the `link` badge remains stroke-oriented.
- **FR-049**: 008 MUST NOT add per-extension/per-language/special-file icon mappings; the current generic fallback contract remains authoritative.
- **FR-050**: Existing symlink/junction badge semantics MUST remain distinguishable if filesystem glyph drawing mode changes.
- **FR-051**: Inline New/Rename inputs MUST retain a clearly visible control surface, small radius and focus border and MUST NOT visually collapse into ordinary row text.
- **FR-052**: 008 MUST preserve the virtualized flat Tree, stable viewport focus owner, pinned inline-edit behavior, logical selection identity, horizontal extent calculation, watcher reconciliation and zero-recursive-I/O guarantees.
- **FR-053**: 008 MUST preserve the current file single-click select / double-click open, directory single-click select / double-click toggle, and chevron toggle-only semantics.

### Scrollbars

- **FR-054**: Editor, Explorer Tree viewport and overflowing document Tab viewport MUST use the same Dark scrollbar visual language where the platform styling API permits.
- **FR-055**: The WebView2/Chromium baseline MUST reserve a fixed approximately 12 CSS-pixel scrollbar lane while drawing an idle thumb approximately 6 CSS pixels wide through transparent borders/background clipping or an equivalent no-layout-shift technique.
- **FR-056**: Hover MUST increase the visible thumb to approximately 8 CSS pixels and increase contrast without changing the lane width.
- **FR-057**: Dragging/active MUST keep approximately the same usable visual width as hover while increasing contrast one additional step.
- **FR-058**: Scrollbar tracks and corners MUST remain transparent or extremely low prominence.
- **FR-059**: Thumb corners MUST be strongly rounded and visually inset from the outer edge.
- **FR-060**: Horizontal and vertical scrollbars MUST use the same geometry/state language.
- **FR-061**: Browser-only fallback MUST remain usable with standard thin-scrollbar properties when Chromium pseudo-element styling is unavailable.
- **FR-062**: 008 MUST NOT add semantic scrollbar markers, minimap behavior, or a custom JavaScript scrollbar subsystem.

### Preservation and Scope

- **FR-063**: 008 MUST preserve all 001–007 document save/baseline, dirty guard, path ownership, external-file state, Workspace/watch, Explorer operation and canonical command semantics.
- **FR-064**: 008 MUST add no new runtime dependency unless an unavoidable current requirement is proven and explicitly approved; the planned implementation requires none.
- **FR-065**: 008 MUST require no Rust source, Tauri capability, Tauri window-configuration, filesystem IPC or watcher-contract change.
- **FR-066**: `DocumentSession`, `ExplorerState`, `WorkContext`, `TabSnapshot` and other business/domain models MUST NOT gain palette, font, radius, gradient, scrollbar or other visual-only state.
- **FR-067**: Existing `UiPreferences` density/sidebar behavior remains the only relevant persisted UI preference surface; 008 MUST NOT add font/theme/appearance persistence before Settings is designed.
- **FR-068**: App Menu, Context Menu, Popover/Tooltip, Footer, Empty State and TopBar MUST NOT receive an independent 008 visual redesign. Inherited central Dark tokens are permitted; geometry/material rewrites are not.
- **FR-069**: Light Theme, formal Theme Engine, Appearance Settings, OS backdrop material, Search/Replace, Workspace Search, Syntax Highlight, Editor language guides, final file-icon theme, Git UI, background images and complex motion are explicitly deferred.
- **FR-070**: Production completion MUST pass `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` from `src-tauri`, plus the 008 manual visual/interaction acceptance matrix defined by the plan/tasks.

### Key Visual Contracts

- **Dark Workspace Token Set**: Central semantic palette and material variables that Editor/Tab/Explorer consume. It is one Dark baseline, not a Theme Engine.
- **Editor Appearance Defaults**: Application-level default font stack, font size, line height and padding consumed by the existing CodeMirror appearance boundary. They are not document preferences.
- **Tab Frame Surface**: Decorative layer inside the existing measured Tab box. It changes appearance without changing `tabLayout.ts` geometry.
- **Explorer Feedback Surface**: Decorative hover/selected layer whose horizontal bounds are stable across row depths. Tree content remains depth-positioned independently.
- **Scrollbar Lane/Thumb Contract**: Fixed interaction lane with a narrower visual thumb; idle/hover/active change thumb appearance without changing scrollport layout.
- **Filesystem Icon Draw Mode**: A minimal rendering distinction that makes the existing generic primary filesystem glyphs appear filled while keeping icon resolution provider-owned and special-file mapping deferred.

## Superseded Presentation Requirements

008 changes presentation only. Earlier specifications remain historical records and all behavioral semantics remain in force.

### SR-001 - 007 Temporary Dark Styling

**Previous 007 behavior**: 007 intentionally shipped temporary coherent colors and explicitly deferred final appearance work.

**008 behavior**: Editor, TabStrip and Explorer now use the first reviewed Dark workspace baseline. This is still not a Theme Engine or final theme catalog.

### SR-002 - 007 Flat/Separator-Oriented Tab Appearance

**Previous implementation**: Tabs primarily used a right separator, hover fill, and an active top accent.

**008 behavior**: Each Tab receives its own small-radius framed visual surface with subtle material/highlight treatment while preserving the exact 007 Tab layout/overflow contract.

### SR-003 - 007 Full-Row Explorer Interaction Fill

**Previous implementation**: `.explorer-row` applied hover/selected background across the row box itself.

**008 behavior**: Hover/selected visuals move to a depth-independent inset feedback surface. Node content still follows depth; feedback geometry does not.

### SR-004 - 007 Generic Stroke Filesystem Glyph Appearance

**Previous implementation**: The generic file/folder fallback artwork shared the stroke-oriented renderer.

**008 behavior**: Generic filesystem primary glyphs MUST use a restrained filled draw mode through the existing provider/renderer seam, while the `link` badge remains stroke-oriented. The fallback ids, provider ownership and no-special-file-mapping rule remain unchanged.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At 1200×780 in Default density, screenshots of Workspace+Explorer+Tabs+Editor show no pure-black Editor plane, no pure-white default Editor text, and no region whose palette/material reads as an unrelated visual system.
- **SC-002**: In the Editor state matrix (ordinary line, current line, selection off current line, selection crossing current line), selection remains the strongest background state and the current line/current line number remain independently identifiable.
- **SC-003**: With a file containing Latin code-like text plus Chinese comments, the Editor renders all ordinary glyphs through the declared fallback stack with no missing-glyph boxes attributable to the 008 font choice; when JetBrains Mono is installed it is the preferred Latin family.
- **SC-004**: The existing 100-Tab fixture remains one row, preserves fixed New/Overview and active reveal, and every visible Tab retains an individual frame with no measurable width/offset change caused by CSS margins/gaps.
- **SC-005**: For Explorer rows at depths 0, 1, 5 and 10+, hover/selected feedback uses the same left/right feedback boundaries (within normal subpixel/CSS rounding) while labels/icons remain depth-indented; a deep unscrolled row still shows a visible feedback band.
- **SC-006**: Default Tree row height is 24 CSS px, Compact remains 20 CSS px, Comfortable becomes 28 CSS px, and the 10,000-row fixture continues to mount only the viewport plus bounded 007 overscan with correct virtual offsets after every density switch.
- **SC-007**: On WebView2, scrollbar lane width remains 12 CSS px in idle/hover/drag states; the visible thumb is approximately 6 CSS px idle and 8 CSS px hover/drag, and measured adjacent content width does not change when the pointer enters/leaves the scrollbar.
- **SC-008**: 008 introduces zero filesystem reads, zero new document-text mirrors, zero new runtime dependencies, zero Rust/Tauri IPC changes, and zero Tauri window-transparency/backdrop changes.
- **SC-009**: The CSS contract audit reports no palette literals outside the central token layer, no `!important`, no forbidden deep/dependency selectors, and no newly introduced `backdrop-filter`/OS-glass escape hatch.
- **SC-010**: All four repository quality gates pass and the existing 007 10,000-row/100-Tab/debug fixtures remain usable for visual acceptance.

## Assumptions

- Sorakada remains Windows-first and the primary desktop renderer is WebView2/Chromium.
- JetBrains Mono may or may not be installed; 008 uses a font-family preference/fallback stack rather than bundling the font.
- The existing 007 `appearanceCompartment` is sufficient as the future application-level CodeMirror appearance seam; 008 does not create a general Settings store.
- Explorer indentation guides in this specification refer only to the existing file-tree hierarchy guides. Editor/code indentation and structure guides remain deferred.
- The 007 Footer/StatusBar remains present and functional but is not a visual target of 008 beyond inherited base tokens.
- 008's fixed visual values are implementation baselines for the first pass and may be revised in later visual specs after real-user acceptance; implementation agents must nevertheless follow them exactly during 008.
