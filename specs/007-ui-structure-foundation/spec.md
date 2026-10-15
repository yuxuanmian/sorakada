# Feature Specification: UI Structure Foundation

**Feature Branch**: `007-ui-structure-foundation`

**Created**: 2026-09-19

**Status**: Ready for implementation — behavior frozen after product clarification and consistency analysis

**Input**: Establish Sorakada's first long-lived UI architecture: a custom desktop shell, scalable Explorer rendering, many-Tab handling, Footer/StatusBar, headless UI primitives, density/preferences foundations, and extension seams for later themes/icons/layouts, while deliberately deferring final colors, glass effects, animation polish, settings pages, split editors and theme plugins.

**Implementation Baseline**: `feature-core` at commit `8c8a9488dc7dfdbd9a7c2bc6e206146b1d9db9f4` (`feat(workspace): 实现工作区文件系统自动同步`). 007 builds on the completed 001–006 behavior and MUST preserve document, Workspace, watcher, path-identity and data-safety semantics unless this specification explicitly supersedes a presentation contract.

## Product Intent

007 is not the final visual redesign. It establishes the structural UI contract that later visual work can safely build on.

Sorakada's long-term visual direction is modern, lightweight and more expressive than a traditional IDE, but 007 intentionally stops before formal theme/appearance work. The default styling only needs to be coherent and usable. The important result is that later Light/Dark themes, Monokai-like editor schemes, glass/blur, custom fonts, richer motion, background images, file-icon themes and theme plugins can be added without rewriting the shell or fighting third-party component internals.

The UI MUST avoid dashboard-style "card everywhere" composition. Sidebar, editor, top chrome and footer are structural regions, not independent floating cards.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use a Stable Desktop Application Shell (Priority: P1)

A user launches Sorakada and gets a desktop-oriented shell with a dedicated TopBar, Sidebar, Editor Workspace and Footer. The window remains usable with zero documents, zero Workspace, or both, and normal window controls continue to behave like a Windows desktop application.

**Why this priority**: Every other 007 surface is hosted by this shell. A custom shell that breaks close guards, drag regions or zero-document states would regress core editor safety.

**Independent Test**: Launch with zero documents and no Workspace, use the TopBar menu and native-style minimize/maximize/close controls, open/close the Sidebar, open a document and Workspace, then close the window with both clean and dirty documents.

**Acceptance Scenarios**:

1. **Given** Sorakada starts with zero documents and no Workspace, **When** the window is rendered, **Then** TopBar, MainArea, Editor Empty State and Footer render without creating a fake document or Workspace.
2. **Given** a Workspace exists with zero documents, **When** the UI renders, **Then** Sidebar remains usable and the Editor Workspace shows its Empty State.
3. **Given** documents exist with no Workspace, **When** the UI renders, **Then** the Editor Workspace and Footer remain usable while Sidebar can show its no-Workspace state.
4. **Given** a custom TopBar, **When** the user drags a non-interactive drag region, **Then** the desktop window moves normally and interactive buttons do not accidentally start a drag.
5. **Given** a resizable window, **When** the user double-clicks the draggable title region or uses the maximize control, **Then** normal maximize/restore behavior is preserved.
6. **Given** the user invokes the TopBar close control with only clean documents, **When** the window-close request runs, **Then** the normal window lifecycle closes the window.
7. **Given** the user invokes the TopBar close control while dirty documents exist, **When** the close request runs, **Then** the existing unsaved-work guard remains authoritative and the custom control MUST NOT bypass it with an unconditional destroy.
8. **Given** Sorakada is rendered in the browser-only Vite development environment, **When** native window APIs are unavailable, **Then** the React shell still renders without crashing and native-only window controls are hidden or safely disabled.
9. **Given** the minimum supported window size, **When** Sidebar and Editor Workspace are both visible, **Then** they remain separate layout regions and neither visually overlays the other.

---

### User Story 2 - Browse Very Large Expanded Trees Efficiently (Priority: P1)

A user can expand many Workspace directories without the Explorer creating one DOM subtree per represented filesystem node. The Tree retains IDEA-like hierarchy cues while staying bounded to the visible viewport.

**Why this priority**: 006 already keeps filesystem reads bounded. Without UI virtualization, a user can still overwhelm the WebView by expanding many already-loaded nodes.

**Independent Test**: Feed an Explorer state containing at least 10,000 materialized visible rows into the UI, scroll through it, change density and Sidebar width, and verify rendered row count stays viewport-bounded while selection, indentation and scrolling remain correct.

**Acceptance Scenarios**:

1. **Given** a Tree with thousands of materialized visible entries, **When** it renders, **Then** the UI flattens the currently visible hierarchy into a linear visible-row projection and virtualizes that projection instead of recursively mounting every row.
2. **Given** 10,000 or more visible rows, **When** the viewport shows only tens of rows, **Then** only the viewport plus bounded overscan is mounted as row elements.
3. **Given** collapsed directories, **When** the visible-row projection is built, **Then** descendants below those collapsed directories are absent from the projection and no filesystem read is triggered by flattening.
4. **Given** an expanded directory has loading/error sentinel state, **When** its visible rows are built, **Then** those sentinel rows participate in the same virtualized sequence and do not break scroll positioning.
5. **Given** Tree rows have different depth, **When** they render, **Then** IDEA-like indentation guides communicate hierarchy without requiring recursively nested DOM containers.
6. **Given** the user scrolls vertically, **When** virtual rows are recycled, **Then** selection, inline-edit identity, context-menu targeting and row accessibility remain bound to logical node identity rather than DOM position.
7. **Given** Density changes while the Tree is mounted, **When** row metrics change, **Then** the virtualizer remeasures/recalculates using the new metrics instead of retaining stale row geometry.
8. **Given** Sidebar width changes, **When** the Tree viewport changes size, **Then** vertical virtualization and horizontal overflow remain correct.
9. **Given** the Workspace contains unexpanded `node_modules` or other very large subtrees, **When** Tree rendering/measurement occurs, **Then** 007 MUST NOT enumerate those descendants for rendering, width calculation or icon resolution.

---

### User Story 3 - Navigate the Explorer Quickly Without Turning It into an Indexer (Priority: P1)

A user can type directly in the focused Explorer to locate currently represented entries, explicitly locate the active Workspace file, collapse the Tree, and manually request Refresh without turning UI navigation into a recursive Workspace scan.

**Why this priority**: Fast navigation is central to the intended IDEA-like Explorer experience, but Sorakada's lazy/no-index architecture must remain intact.

**Independent Test**: Open a Workspace where only some branches are loaded, use direct type-to-search, Locate Current File, Collapse All and Refresh, and record filesystem reads. Direct type-to-search must issue no reads; Locate may read only the active file's known ancestor chain; Refresh retains 006 bounded reconciliation semantics.

**Acceptance Scenarios**:

1. **Given** Explorer owns keyboard focus and no inline editor/menu/dialog is consuming text, **When** the user types a printable search character, **Then** the left side of the Explorer Header becomes a transient search input while right-side Header actions remain stationary.
2. **Given** a transient Explorer query, **When** it changes, **Then** matching is limited to the current materialized/visible row projection and MUST NOT read, expand or recursively inspect collapsed directories.
3. **Given** matches exist, **When** the user navigates the query results, **Then** selection/scroll can move to matching visible rows without opening files automatically.
4. **Given** the transient search is active, **When** the user presses Escape, **Then** the query closes and the Header returns to its normal `Files` presentation without mutating Tree expansion.
5. **Given** IME composition or another text-owning control is active, **When** keyboard events occur, **Then** the Explorer's direct-search trigger MUST NOT treat composition/owned input as raw search shortcuts.
6. **Given** the active document is a disk-backed file inside the current Workspace, **When** the user invokes Locate Current File, **Then** Sorakada may lazily load only the known ancestor chain required to reveal that exact path, select/reveal the target and MUST NOT enumerate unrelated branches.
7. **Given** the active document is untitled, outside the Workspace, missing from the current WorkContext, or cannot be resolved/read, **When** Locate Current File is invoked, **Then** it fails safely without scanning the Workspace or changing document state.
8. **Given** the user invokes Collapse All, **When** the Tree collapses, **Then** document Tabs and active-document identity are unchanged; hidden descendant selection may remain logically selected but is not forced visible.
9. **Given** 006 watcher synchronization is healthy, **When** the Explorer Header is shown, **Then** Refresh is a low-prominence fallback under `More`/context surfaces rather than a primary Header button.
10. **Given** the user explicitly invokes Refresh, **When** reconciliation runs, **Then** 006's existing bounded/stale-safe Refresh behavior remains authoritative.

---

### User Story 4 - Work Comfortably with Many Open Tabs (Priority: P1)

A user can open many documents without multi-row Tabs, microscopic labels or losing the active Tab. Tabs belong to the editor group rather than the global application chrome.

**Why this priority**: 007 changes the shell and Tab presentation contract. The new structure must scale from zero Tabs to many Tabs and must leave a credible path toward future split/editor-group designs.

**Independent Test**: Open 1, 20 and 100 documents, activate Tabs near both ends, resize the window and Sidebar, create/close Tabs, and use the Tab Overview to activate an off-screen document.

**Acceptance Scenarios**:

1. **Given** the Editor Workspace contains one editor group, **When** it renders, **Then** that group owns its own TabStrip and EditorHost; the AppShell does not own one global TabBar contract.
2. **Given** few Tabs, **When** there is available width, **Then** Tabs may use a comfortable width up to the configured maximum.
3. **Given** Tab count increases, **When** space becomes constrained, **Then** Tabs shrink only to a configured minimum width and remain on one horizontal row.
4. **Given** Tabs cannot fit at their minimum widths, **When** more Tabs are present, **Then** only the Tab list scrolls horizontally; Tabs MUST NOT wrap onto multiple rows.
5. **Given** an off-screen Tab becomes active through Explorer, Open, Tab Overview or another document action, **When** active identity changes, **Then** the active Tab is automatically brought into the Tab viewport.
6. **Given** many Tabs overflow, **When** the Tab list scrolls, **Then** the fixed action area containing New (`+`) and the overflow/overview entry remains reachable and does not scroll with the document Tabs.
7. **Given** zero Tabs, **When** the EditorGroup renders, **Then** New remains reachable and the EditorHost shows the existing Empty State.
8. **Given** the Tab Overview is opened, **When** documents are listed, **Then** it reflects current Tab order/identity, can filter by display name/path, marks relevant dirty/external state, and activates the selected existing document without creating a duplicate.
9. **Given** Tab Overview is not needed because no Tabs overflow, **When** the action area renders, **Then** the Overview control may be visually suppressed while New remains available.
10. **Given** 007's single EditorGroup, **When** Tab presentation code is implemented, **Then** it MUST NOT store visual style such as rounded/big/colored/merged Tab state in `DocumentSession`.
11. **Given** later work introduces split groups or alternate Tab presentations, **When** that happens, **Then** 007's component hierarchy and Tab presentation contracts must not require moving Tabs out of a global AppShell singleton first.

---

### User Story 5 - Use Consistent Menus, Context Menus and Overlay Surfaces (Priority: P1)

A user interacts with one compact in-application App Menu and consistent popup/context-menu behavior. Standard popup semantics come from a headless primitive layer, while Sorakada retains full control of DOM-facing wrappers and CSS.

**Why this priority**: 007 intentionally replaces ad-hoc popup behavior and the visible native menu bar. If the third-party primitive leaks through the application, future theme work will recreate the same styling lock-in 007 is meant to avoid.

**Independent Test**: Open the TopBar App Menu and Explorer context menus using mouse and keyboard, navigate items/submenus, dismiss with Escape/outside interaction, resize the window and verify overlays remain above the shell without being clipped by Sidebar/Editor overflow.

**Acceptance Scenarios**:

1. **Given** the TopBar App Menu button, **When** the user activates it, **Then** a compact Sorakada-styled popup exposes existing application commands grouped into discoverable submenus/sections.
2. **Given** a command is disabled in the shared command registry, **When** it appears in a popup/menu surface, **Then** the UI uses the registry's same availability decision and cannot execute the handler.
3. **Given** an existing keyboard shortcut, **When** it is shown in the compact menu, **Then** the displayed accelerator is derived from the same keymap data used by keyboard dispatch.
4. **Given** Explorer context actions, **When** a context menu opens, **Then** it preserves 003/004 operation-target rules while gaining headless keyboard/focus/dismiss behavior.
5. **Given** a menu, context menu, tooltip or future popup, **When** it portals outside the triggering layout region, **Then** a shared overlay/portal layer keeps it above AppShell content without relying on arbitrary per-component z-index escalation.
6. **Given** application code outside the Sorakada UI primitive layer, **When** it needs a menu/popover/dialog/tooltip primitive, **Then** it imports a Sorakada wrapper rather than importing Base UI directly.
7. **Given** later visual work changes radius, glass, color or animation, **When** Sorakada wrappers are restyled, **Then** normal styling MUST NOT require `!important`, selectors into undocumented third-party DOM structure, or deep-selector escape hatches.
8. **Given** browser-only development mode, **When** the compact in-WebView menu renders, **Then** it remains usable even though Tauri native menu/window APIs are absent.

---

### User Story 6 - Adapt UI Density and Sidebar Space Across Displays (Priority: P2)

A user can resize the Sidebar broadly and switch among Compact, Default and Comfortable density presets. The same shell remains usable across logical window sizes and when moved between high- and low-DPI displays.

**Why this priority**: Sorakada is expected to be tested on a 2160p primary display and 1080p secondary display. Hard-coding one set of physical-pixel assumptions would make later visual work unreliable.

**Independent Test**: On Windows, move the application between 2160p and 1080p displays (including different system scaling where available), switch density, resize Sidebar from its minimum to a large share of the window, and verify no overlap, stale virtual-row geometry or misplaced popup.

**Acceptance Scenarios**:

1. **Given** any supported display, **When** the shell renders, **Then** layout is based on WebView/CSS logical pixels and system DPI handling rather than branching on physical `1080p/1440p/2160p` resolution.
2. **Given** Compact, Default or Comfortable density, **When** it is selected, **Then** shared density tokens update coordinated control metrics such as Tree row height/indent, Tab height, menu item height and spacing.
3. **Given** UI typography, **When** density changes, **Then** density does not implicitly become an editor-font setting; typography and density remain separate concerns.
4. **Given** the user drags the Sidebar splitter, **When** space is available, **Then** the Sidebar can grow substantially beyond the old fixed 640px ceiling while preserving a minimum usable Editor region.
5. **Given** the window becomes narrow, **When** the Sidebar would otherwise consume the Editor, **Then** the layout clamps/adapts without Sidebar/Editor overlap.
6. **Given** Sidebar content is deeper/wider than the visible area, **When** it overflows horizontally, **Then** only the Tree content viewport scrolls horizontally and the Sidebar Header remains fixed.
7. **Given** a very long materialized visible Tree row that is currently outside the vertical virtual viewport, **When** horizontal extent is determined, **Then** the Tree can still expose sufficient horizontal scroll width without mounting every row or reading unopened directories.
8. **Given** persisted simple UI preferences are malformed or from an unsupported schema, **When** Sorakada starts, **Then** it falls back to safe defaults instead of failing to render.

---

### User Story 7 - Read Workspace and Document Context from a Dedicated Footer (Priority: P2)

A user can glance at a thin application-level Footer for filesystem/document context without sacrificing editor content area to an editor-owned status overlay.

**Why this priority**: The Footer is an intentional structural region with future room for breadcrumbs, Git context and document status. It should exist before later features attempt to scatter status throughout the shell.

**Independent Test**: Switch between no document, untitled document, Workspace-inside file and outside file; verify the Footer updates without affecting editor layout or document state.

**Acceptance Scenarios**:

1. **Given** AppShell renders, **When** MainArea changes, **Then** Footer remains a separate full-width AppShell region below Sidebar and EditorWorkspace rather than being embedded in EditorHost.
2. **Given** an active file inside the Workspace, **When** the Footer renders, **Then** its left context can show a filesystem breadcrumb derived from the current Workspace/path relation without changing Explorer selection.
3. **Given** an outside file or Untitled document, **When** Footer context is rendered, **Then** it shows a sensible non-Workspace path/name representation without creating or changing a Workspace.
4. **Given** an active document, **When** the Footer renders its initial right-side status items, **Then** it shows already-owned document metadata including encoding and preferred line ending without duplicating or mutating that state.
5. **Given** no active document, **When** Footer renders, **Then** document-only right-side items disappear cleanly while Workspace context may remain.
6. **Given** status content becomes too wide, **When** available horizontal space is constrained, **Then** Footer uses priority/overflow behavior rather than forcing the application wider or covering MainArea.
7. **Given** future Git/status features, **When** they are added, **Then** 007's Footer provides left/right slots but does not itself implement Git/source-control behavior.

---

### User Story 8 - Inspect and Validate the UI Foundation During Development (Priority: P3)

A maintainer can switch density and inspect Tree virtualization without a full Settings page, making it practical to validate the foundation on different screens and large fixtures.

**Why this priority**: 007 intentionally defers the full settings system, but its most important structural claims need a direct way to be tested and debugged.

**Independent Test**: Use the compact App Menu to switch density, toggle Explorer, reset Sidebar width, enable virtual-row debug information, and verify values update through one UI preference/debug owner.

**Acceptance Scenarios**:

1. **Given** the compact App Menu, **When** the user opens View, **Then** Density offers Compact, Default and Comfortable choices without requiring a Settings page.
2. **Given** Sidebar layout preferences, **When** the user changes visibility/width/density, **Then** components consume a shared `UiPreferences` owner rather than each reading browser storage directly.
3. **Given** persisted `UiPreferences`, **When** Sorakada restarts, **Then** supported simple preferences such as density, Sidebar visibility and Sidebar width restore through the preference owner.
4. **Given** a development/debug build, **When** UI Debug is enabled, **Then** maintainers can inspect at least visible-node count, rendered virtual-row count and current virtual range.
5. **Given** debug row-bound/range visualization is toggled, **When** it renders, **Then** it does not alter Tree filesystem state, document state or production preference data.
6. **Given** a production build, **When** debug-only diagnostics are not intended for end users, **Then** they may be omitted while ordinary density/Sidebar preferences remain functional.

### Edge Cases

- The current `AppShell` uses a decorated Tauri window and a plain React header. Converting to custom chrome MUST preserve native close interception and MUST NOT call `destroy()` directly from the visual close button.
- Browser-only Vite development does not have Tauri window capabilities; native controls and window calls must degrade safely.
- Interactive descendants inside a drag region (menu button, window controls) must opt out of dragging so clicks are never swallowed by title dragging.
- 007 does not change the existing window title synchronization (`*foo.txt - Sorakada` / `Sorakada`). Hiding native decorations does not make the title state unnecessary.
- The existing `AppMenu` is native. 007 may remove that visible native surface, but command ids, keymap data, availability rules and command handlers remain canonical and reusable by the compact in-WebView menu.
- Current Explorer Tree rendering is recursive. The virtualized Tree must preserve current single-click/double-click/chevron/inline-edit/context-menu semantics from 004 while changing only its projection/rendering architecture.
- A selected or inline-edited row can leave the vertical viewport and be unmounted by virtualization. Logical selection/edit state must remain owned by `ExplorerController`; unmounting a row must not implicitly cancel it.
- Explorer keyboard focus should be owned by a stable Explorer focus container rather than by recyclable row DOM; row click/selection must survive the selected row being virtualized out of view. An active inline-edit input is the deliberate exception and must remain mounted/pinned until the edit ends.
- If an inline editor is logically active, the UI must scroll/render that row before focusing the input. A virtual row disappearing due to unrelated scrolling must not commit filesystem work.
- Loading/error sentinel rows must have deterministic metrics compatible with virtualization; long error text must not expand over adjacent rows or the Editor region.
- Virtualization and horizontal scrolling interact: an off-screen wide row cannot contribute natural DOM `scrollWidth`. Horizontal extent therefore must be derived from the materialized visible-row projection (for example cached text measurement + depth metrics) rather than by mounting all rows.
- Width measurement must never enumerate filesystem state beyond the already materialized Explorer model.
- Tree type-to-search works on the *current visible/materialized projection*. It is not a Workspace filename search and does not match descendants hidden under collapsed ancestors.
- Locate Current File is an explicit user request and may expand/load only the direct ancestor chain of the known active file path. It is not permission to recursively search for a file by name.
- A watcher update can add/remove/rebase nodes while a transient search is open. Search results must be recomputed from the newest visible projection and stale row indexes must not be treated as identity.
- A watcher update can remove the selected/search-matched node. Selection/reconciliation rules from 006 remain authoritative; the search UI must tolerate the match disappearing.
- Collapse All may hide a logically selected descendant. It does not close documents or rewrite document/Workspace relation.
- Explorer `Refresh` remains available as a fallback even though watcher synchronization is normal. Moving it into `More` must not remove the existing command or context-menu paths. New File/New Folder also remain discoverable from `More` where the current operation context permits them.
- The Tree's horizontal scrollbar is a fallback. Hovering a long filename MUST NOT expand ordinary Tree content over the Editor. Tooltips/popups, when used, belong to the overlay layer and do not change structural layout.
- Tab widths must not collapse below the minimum merely to avoid overflow. One-row overflow is preferred over multi-row Tabs.
- A fixed Tab action area reduces the width available to the scroll viewport; `scrollIntoView` logic must reveal active Tabs within that viewport rather than beneath the fixed action region.
- Tab Overview results are snapshots of current open documents. Closing/renaming/rebinding documents while the overview is open must update or safely invalidate the corresponding item.
- Per-Tab visual accent, merged/big Tabs and multi-group split layouts are future presentation features. 007 must not add flags to `DocumentSession` for those visuals.
- 007 keeps the existing single live CodeMirror `EditorView`. The `EditorGroup` component boundary is a future layout seam, not a new multi-view document architecture.
- Footer breadcrumb display is not automatic Tree synchronization. Switching Tabs MUST NOT select/expand Explorer merely because the breadcrumb changed.
- Footer encoding/EOL labels are read-only in 007; clicking them does not yet change encoding/EOL.
- Simple preference persistence is UI-only state. It must not be mixed with document/session/recovery persistence.
- Debug-only visualization must never be necessary for normal user behavior.
- A corrupt preference payload must be ignored/reset conservatively; it must not prevent startup.
- Density changes can invalidate virtualizer row height and cached horizontal text measurements; both must be recomputed.
- CSS logical pixels are not physical display pixels. 007 MUST NOT detect 4K/1080p and choose hard-coded component dimensions from that physical resolution.
- Popup/portal positioning must remain correct after moving the window between displays with different DPI scale and after resize.
- No UI migration in 007 may weaken 005 external-change indicators, 006 watcher convergence, 004 inline-edit rules, 003 disk-first filesystem mutation, or 001/002 document safety.

## Requirements *(mandatory)*

### AppShell and Window Chrome

- **FR-001**: `AppShell` MUST expose four stable structural regions: TopBar, MainArea, FooterBar, with MainArea containing Sidebar and EditorWorkspace.
- **FR-002**: `EditorWorkspace` MUST host one `EditorGroup` in 007; that group MUST contain its own TabStrip and EditorHost/EmptyState.
- **FR-003**: 007 MUST support zero documents and zero Workspace as independent valid states without introducing placeholder document sessions or WorkContexts.
- **FR-004**: TopBar MUST be an application/window-level region and MUST NOT host document Tabs.
- **FR-005**: 007 MUST use custom window chrome on the desktop build so TopBar can own App Menu, drag region and window controls without a second native title/menu strip.
- **FR-006**: Drag regions and interactive regions MUST be explicitly separated; menu/window-control interactions MUST NOT start window dragging.
- **FR-007**: Minimize and maximize/restore controls MUST call the supported Tauri window API and remain unavailable/safe in browser-only mode. Double-clicking the non-interactive draggable TopBar region MUST dispatch the same canonical maximize/restore command exactly once; interactive descendants MUST NOT trigger it.
- **FR-008**: The visual Close control MUST request normal window close and therefore reuse the existing dirty-aware close lifecycle; it MUST NOT force-destroy the window directly.
- **FR-009**: Existing window-title synchronization and dirty-title semantics MUST remain active even when native title decorations are hidden.
- **FR-010**: Sidebar, EditorWorkspace and Footer MUST remain non-overlapping structural regions at the supported minimum window size.
- **FR-011**: TopBar MUST remain intentionally sparse: 007 MUST NOT introduce a traditional always-visible toolbar of File/Open/Save/Undo/Redo/etc. buttons.
- **FR-012**: 007 MAY retain lightweight transition effects for basic chrome interactions, but shell usability MUST NOT depend on animation completion.

### Sorakada UI Primitive Layer and CSS Contract

- **FR-013**: 007 MUST introduce a Sorakada-owned UI primitive/wrapper layer for standard popup interactions used by the feature.
- **FR-014**: Base UI MAY be used as the headless behavior implementation underneath that layer; application/feature components outside the wrapper layer MUST NOT import Base UI components directly.
- **FR-015**: The wrapper layer MUST provide a shared overlay/portal strategy so Menu, Context Menu, Tooltip/Popover and later Dialog surfaces are not clipped by Sidebar/Editor overflow.
- **FR-016**: App Menu and Explorer Context Menu MUST route user-visible actions through stable application command/action paths rather than embedding filesystem/document behavior in the primitive wrapper.
- **FR-017**: 007 styling MUST continue to use semantic/shared CSS variables for palette, spacing, radii, density metrics and structural dimensions.
- **FR-018**: Feature components MUST NOT require `!important`, undocumented third-party DOM selectors, deep selectors, or dependency-specific class-name overrides for ordinary styling/customization.
- **FR-019**: New hard-coded palette values MUST be centralized in the root token layer; component styles MUST NOT introduce independent color palettes.
- **FR-020**: 007 MUST provide coherent default styling but MUST NOT implement a formal Theme Engine, Theme Plugin API, Light/Dark switcher or final Appearance system.

### Compact App Menu

- **FR-021**: TopBar MUST expose one compact App Menu trigger instead of relying on an always-visible native File/Edit/View menu bar.
- **FR-022**: The compact App Menu MUST expose the existing command set in logical groups and MUST derive enabled/disabled state from `CommandRegistry`.
- **FR-023**: Shortcut labels displayed in the App Menu MUST derive from the existing keymap profile rather than duplicating shortcut text.
- **FR-024**: The visible compact App Menu MUST work in browser-only development mode for commands whose handlers are available there.
- **FR-025**: A permanent Classic menu bar, Alt-replacement menu mode and full menu-style setting are deferred; 007 MUST NOT require them.

### Sidebar and Explorer Header

- **FR-026**: Sidebar MUST remain a generic shell region, but 007 MUST treat Explorer as its only concrete tool view; no Tool Registry or Activity Bar is required.
- **FR-027**: Explorer Header MUST present a stable left title/search area and a stable right action area so entering transient search does not move the action controls.
- **FR-028**: Normal Explorer Header actions MUST include Locate Current File, Collapse All and More.
- **FR-029**: Refresh MUST remain available through More and existing appropriate context-menu surfaces but MUST NOT remain a prominent dedicated Header button.
- **FR-030**: Explorer `More` MUST provide discoverable low-frequency actions including New File/New Folder when their current operation context permits them and Refresh; `More`, context menus and other Explorer action surfaces MUST reuse shared command availability/target rules rather than redefine operation context.

### Flattened and Virtualized Explorer

- **FR-031**: Explorer rendering MUST derive a linear `VisibleNodeList` (or equivalent projection) from `ExplorerState` before rendering rows.
- **FR-032**: The visible projection MUST contain only the root plus descendants whose ancestor expansion makes them visible; collapsed descendants MUST NOT appear.
- **FR-033**: Building the visible projection MUST be pure with respect to filesystem I/O: it MUST NOT read directories, resolve new paths, or recursively enumerate the Workspace.
- **FR-034**: Each visible row projection MUST carry stable logical identity and enough metadata for rendering/navigation, including at least node/path identity, depth, row kind and expansion/load/selection information.
- **FR-035**: Explorer row rendering MUST be vertically virtualized in 007 using a mature virtualizer rather than a custom scroll-window implementation.
- **FR-036**: Virtualization MUST render only the viewport plus bounded overscan and MUST NOT mount all visible rows merely to calculate scrolling.
- **FR-037**: Virtualized row unmount/remount MUST NOT own or reset Explorer selection, expansion, inline-edit or filesystem-operation state; while an inline-edit input is active, the corresponding logical row MUST remain mounted/pinned as necessary so virtualization alone cannot trigger its blur/cancel semantics.
- **FR-038**: Density changes and viewport resize MUST invalidate/recalculate virtualizer row metrics.
- **FR-039**: Tree hierarchy MUST render IDEA-like indentation guides from row depth/ancestor metadata without requiring nested DOM containers for every ancestor.
- **FR-040**: Loading/error/cycle sentinel rows MUST participate safely in the flattened/virtualized model and MUST NOT overlap adjacent rows.
- **FR-041**: Explorer MUST keep the root row as the stable Tree anchor; 007 MUST NOT permanently consume Sidebar width with the full absolute root path.
- **FR-042**: Tree content MAY scroll horizontally when materialized visible content exceeds Sidebar width; Header MUST remain outside that horizontal scroll viewport.
- **FR-043**: Horizontal extent MUST account for materialized visible rows even when the widest row is currently vertically virtualized out of the DOM, without mounting all rows.
- **FR-044**: Horizontal extent calculation MUST NOT inspect never-materialized filesystem descendants.
- **FR-045**: Ordinary long-name rendering MUST remain within the Tree region; it MUST NOT visually expand across the Editor region on hover.

### Explorer Search and Navigation

- **FR-046**: When Explorer owns keyboard focus, a direct printable-key search trigger MAY activate transient type-to-search if no other text-owning control/composition is active.
- **FR-047**: Type-to-search MUST match only the current visible/materialized row projection and MUST cause zero filesystem directory reads.
- **FR-048**: Search result navigation MUST track logical row identity rather than retaining stale virtual list indexes across reconciliation.
- **FR-049**: Escape MUST close transient Explorer search without changing Tree expansion or document state.
- **FR-050**: IME composition and inline create/rename inputs MUST not be hijacked by Explorer type-to-search handling.
- **FR-051**: Locate Current File MUST be available only when the active document is meaningfully locatable in the current Workspace.
- **FR-052**: Locate Current File MAY load/expand the active file's exact known Workspace ancestor chain one directory level at a time and MUST NOT search unrelated branches.
- **FR-053**: Failed/unsupported Locate MUST leave document state unchanged and MUST NOT fall back to recursive filename search.
- **FR-054**: Collapse All MUST collapse represented Tree expansion without closing documents or rewriting document/Workspace relation.
- **FR-055**: Explorer selection remains independent from active document except when the user explicitly invokes Locate Current File.

### Icon Extension Contract

- **FR-056**: 007 MUST separate UI action icons from filesystem entry icons behind Sorakada-owned `UiIconProvider` and `FileIconProvider` (or equivalent) contracts.
- **FR-057**: `FileIconProvider` MUST accept filesystem-node metadata and return an icon descriptor without requiring Explorer rows to hard-code extension/name branches.
- **FR-058**: 007 MAY use generic file/folder/default icons only, but every file/directory/other entry MUST have a safe fallback icon.
- **FR-059**: Future special-file/language/file-icon-theme support (`.gitignore`, `.env`, `package.json`, `Cargo.toml`, compose files, etc.) MUST be implementable by replacing/extending the provider rather than rewriting Explorer row logic.
- **FR-060**: File icon providers MUST NOT read file contents or recursively inspect the Workspace during row rendering.

### TabStrip and EditorGroup

- **FR-061**: Tabs MUST be a child concern of `EditorGroup`, not a global TopBar/AppShell concern.
- **FR-062**: 007 MUST implement exactly one EditorGroup and MUST preserve the existing single live CodeMirror `EditorView`; it MUST NOT introduce a GroupManager or split editor.
- **FR-063**: Tab semantic state (document id, active, dirty, external state) MUST remain a projection of document state and MUST stay separate from presentation state such as hover, strip scroll, overflow or future accent/group presentation.
- **FR-064**: Document Tabs MUST remain on one row.
- **FR-065**: Tabs SHOULD shrink from a comfortable maximum toward a minimum width as space decreases; once the minimum is reached the Tab viewport MUST horizontally overflow rather than shrink further or wrap.
- **FR-066**: Active Tab changes MUST bring the active Tab into the scroll viewport without changing Tab order.
- **FR-067**: TabStrip MUST have a fixed action region outside the document-tab scroll viewport containing at least New (`+`) and an overflow/overview affordance when needed.
- **FR-068**: New (`+`) MUST remain visible with zero Tabs and during document-tab overflow and MUST remain behaviorally equivalent to File > New / Ctrl+N.
- **FR-069**: The Tab Overview MUST list current open documents, support lightweight filtering by display name/path, expose relevant dirty/external state, and activate an existing document through the canonical document-selection path.
- **FR-070**: Tab Overview MUST NOT create duplicate sessions, reorder Tabs, or become a second owner of document metadata.
- **FR-071**: 007 MUST NOT implement multi-row Tabs, Tab drag/reorder, pinning, split groups, merged/big Tabs or per-Tab theme customization.
- **FR-072**: Tab visuals MUST use semantic tokens so later active/per-group/per-tab accents can be introduced without storing visual styling in `DocumentSession`.

### Footer / StatusBar

- **FR-073**: FooterBar MUST be an AppShell-level, full-width region below MainArea and MUST NOT be implemented as an overlay inside CodeMirror/EditorHost.
- **FR-074**: FooterBar MUST expose separate left-context and right-status composition slots.
- **FR-075**: 007 MUST provide a basic filesystem/document breadcrumb on the left derived from the existing active-document path identity and current WorkContext canonical identity (or another existing filesystem-aware relation result); it MUST NOT use lexical prefix containment and rendering it MUST NOT mutate Explorer selection/expansion.
- **FR-076**: 007 MUST show currently owned read-only document format metadata including UTF-8 and the preferred LF/CRLF line ending on the right when a document is active; it MUST NOT introduce encoding/EOL editing controls in this feature.
- **FR-077**: With no active document, document-only Footer items MUST disappear cleanly while Workspace-level context may remain.
- **FR-078**: Footer content MUST remain thin/low-prominence and MUST use truncation/priority/overflow behavior rather than expanding the window or covering MainArea.
- **FR-079**: Git branch, Problems, background-task details, cursor line/column controls and other richer status systems are deferred unless already available without new subsystem ownership.

### Density, Sidebar Layout and Preferences

- **FR-080**: 007 MUST define `compact`, `default` and `comfortable` UI density modes through shared density/layout tokens.
- **FR-081**: Density MUST coordinate structural metrics (for example Tree row/indent, Tab/menu/control heights and gaps) and MUST remain conceptually separate from editor typography and future UI Scale.
- **FR-082**: 007 MUST NOT choose density by inspecting physical display resolution.
- **FR-083**: Sidebar MUST have a practical minimum width and a dynamic maximum governed primarily by preserving at least 320 CSS logical pixels for EditorWorkspace, replacing the old fixed 640px ceiling.
- **FR-084**: Sidebar resize MUST never visually overlap EditorWorkspace; when width must be clamped, clamping MUST be deterministic from current layout bounds. The persisted `sidebarWidth` represents the user's preferred width, so passive clamping caused only by a temporarily narrow window/display MUST NOT overwrite that preferred value.
- **FR-085**: 007 MUST provide one shared `UiPreferences` owner for density, Sidebar visibility and Sidebar width.
- **FR-086**: Supported simple UI preferences MUST persist across restarts through that owner; feature components MUST NOT read/write browser storage directly.
- **FR-087**: Preference persistence MUST be versioned/validated enough to fall back to defaults when data is absent, malformed or incompatible.
- **FR-088**: 007 MUST provide a lightweight View/App Menu entry to switch density, toggle Explorer and reset Sidebar width without implementing a full Settings page.
- **FR-089**: Development diagnostics such as row bounds, visible/rendered counts and virtual range MUST be held separately from persisted user preferences and MAY be omitted from production builds.
- **FR-090**: The 007 layout MUST be adaptive as a desktop UI (clamping/overflow/hiding low-priority controls) rather than transforming into a mobile/web responsive layout at narrow widths.

### Preservation and Scope

- **FR-091**: 007 MUST preserve 004 Explorer click/double-click/chevron and inline-edit semantics while changing Tree rendering architecture.
- **FR-092**: 007 MUST preserve 005 external document state markers and all dirty/baseline semantics.
- **FR-093**: 007 MUST preserve 006 automatic Workspace watcher synchronization, stale-result protection, bounded reconciliation and no-recursive-crawl guarantees.
- **FR-094**: 007 MUST preserve 003 filesystem operation targeting, disk-first commit rules, path ownership and WorkContext/document independence.
- **FR-095**: UI-only operations (rendering, type-to-search, measurement, density, Tab overview, Footer) MUST NOT introduce filesystem walks or new document-content mirrors in React.
- **FR-096**: Existing user-visible actions migrated to new UI surfaces MUST continue to execute through canonical commands/handlers and MUST execute at most once per invocation.
- **FR-097**: 007 MUST add only dependencies justified by current structural requirements; a full UI framework, theme framework, animation framework or settings framework is not justified by this feature.
- **FR-098**: Production completion MUST pass `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` from `src-tauri`, plus the 007 manual desktop acceptance matrix for custom chrome, cross-DPI behavior and large virtualized Tree interaction.

### Key Entities *(include if feature involves data)*

- **AppShell Layout**: The structural composition of TopBar, MainArea and FooterBar. It owns layout composition, not document or filesystem state.
- **EditorWorkspace**: The content-side shell region hosting EditorGroup(s). 007 contains exactly one EditorGroup.
- **EditorGroup**: A presentation/composition boundary containing one TabStrip and one EditorHost. In 007 it does not introduce a new document owner or additional CodeMirror view.
- **TabStrip View State**: UI-only state such as horizontal scroll/overflow and open overview state. It does not own document metadata.
- **VisibleNodeRow**: One flattened visible Explorer row derived from `ExplorerState`, including stable logical identity, depth and render metadata.
- **Virtualized Tree Viewport**: The UI projection that mounts only viewport/overscan rows while `ExplorerController` remains the owner of Tree state.
- **Explorer Quick Search State**: Transient UI query/match state over the visible row projection. It has no filesystem/search-index ownership.
- **UiPreferences**: Small persisted UI-only preferences for density and Sidebar layout. It is distinct from Settings, Session/Recovery and document state.
- **UiDebugOptions**: Non-persistent developer diagnostics for virtualized Tree/layout inspection.
- **UiIconProvider**: The application-action icon resolver used by Sorakada-owned UI primitives/components.
- **FileIconProvider**: The filesystem-entry icon resolver that can later support special files/languages/icon themes without Tree-specific extension branches.
- **Overlay Root**: The shared portal/stacking boundary for popup surfaces.
- **Footer Context/Status**: Derived read-only presentation from existing Workspace/document metadata; it does not own those facts.

## Superseded Requirements

007 intentionally updates several presentation contracts from earlier milestones. Earlier specifications remain historical records; the rules below take precedence from 007 onward.

### SR-001 - Scrolling TabBar New Button

**Previous 004 behavior**: 004 FR-018–FR-021 placed the TabBar `+` inside the horizontally scrolling Tab strip immediately after the final Tab, allowing it to leave the viewport.

**007 behavior**: The document Tab list and fixed Tab action region are separate. New (`+`) remains fixed/reachable outside the scrolling document list, and a Tab Overview/overflow control may share that fixed action region. The New command semantics remain unchanged.

### SR-002 - Explorer Header Refresh

**Previous 003 behavior**: 003 FR-082 required the same manual Refresh to be directly available from the Explorer Header and context menus because 003 had no continuous watcher.

**006 context**: 006 made automatic watcher/reconciliation the normal synchronization mechanism while retaining manual Refresh as a convergence fallback.

**007 behavior**: Refresh remains the same command and reconciliation path but is visually de-emphasized under Explorer `More` and applicable context menus rather than consuming a primary Header button.

### SR-003 - Locate Current File Deferred

**Previous 003 behavior**: 003 FR-040 explicitly deferred automatic or explicit Tab-to-Tree location.

**007 behavior**: Automatic Tab-to-Tree synchronization remains prohibited, but an explicit Locate Current File Header action is now implemented. It may reveal the known active Workspace file by loading only its exact ancestor chain.

### SR-004 - Empty StatusBar Prohibition

**Previous 003 behavior**: 003 FR-097 prohibited adding an empty StatusBar solely as a placeholder.

**007 behavior**: FooterBar is now justified by current structure and populated with basic filesystem/document context/status. It is a first-class AppShell region, not an empty placeholder.

### SR-005 - Non-persistent Sidebar Layout

**Previous 003 behavior**: 003 FR-094 explicitly did not require Sidebar width/visibility persistence.

**007 behavior**: 007 introduces a minimal `UiPreferences` persistence owner for density and Sidebar layout. This does not create the full Settings system or Session persistence.

### SR-006 - Native Visible Application Menu

**Previous behavior**: Earlier milestones installed a visible native File/Edit/View application menu using Tauri menu APIs while the WebView handled the actual shortcut dispatch.

**007 behavior**: The primary discoverable menu becomes one compact Sorakada menu in TopBar, backed by the same command registry/keymap semantics. The native visible menu surface is no longer required. This changes presentation only; command execution and availability remain canonical.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With 10,000 materialized visible Tree rows in a 1200×780 logical-pixel window, fewer than 200 Explorer row DOM elements are mounted at steady state, and scrolling from top to bottom does not cause the mounted count to grow with total visible-node count.
- **SC-002**: Type-to-search across a fixture with collapsed/unloaded descendants performs zero Workspace directory reads and does not change expansion state.
- **SC-003**: Locate Current File on a file nested at depth N reads no unrelated sibling branch; any new directory reads are bounded to the known ancestor chain required to reveal that file.
- **SC-004**: With 100 open Tabs, the TabStrip stays on one row, New remains reachable, activating any Tab causes that Tab to become visible, and Tab Overview activates the existing matching document without creating another session.
- **SC-005**: At the configured 640×400 minimum window size and throughout Sidebar drag, Sidebar and EditorWorkspace never overlap; at larger windows the Sidebar can grow beyond 640 CSS logical pixels while at least 320 CSS logical pixels remain available to EditorWorkspace.
- **SC-006**: Compact, Default and Comfortable density can be switched at runtime without stale Tree row positions, lost Explorer selection, document mutation or application reload.
- **SC-007**: Moving a running desktop window between the available 2160p and 1080p displays (including differing Windows scale factors when configured) leaves text readable, popup placement correct, window controls usable, Tab overflow correct and Tree virtualization aligned after the move.
- **SC-008**: Clicking the custom Close control with a dirty document still reaches the existing unsaved-work guard; cancellation keeps the window open and leaves document state unchanged.
- **SC-009**: Static/source checks for the 007-owned UI code find no ordinary `!important` overrides, no selectors into undocumented Base UI internals, no direct Base UI imports outside the Sorakada UI primitive layer, and no new component-local hard-coded palette.
- **SC-010**: Rendering, measuring, density switching, Tab overview and Footer updates add zero recursive Workspace scans; 006's large collapsed-subtree guarantees remain green.
- **SC-011**: The Footer remains a separate full-width region in zero-document, Workspace-only, document-only and combined states, and its basic breadcrumb/format information always agrees with existing application-owned metadata.
- **SC-012**: All four repository quality gates pass, and manual desktop acceptance covers custom chrome drag/minimize/maximize/close, browser fallback, Sidebar resizing, many Tabs, large virtualized Tree, transient search, Footer states and cross-display/DPI behavior.

## Assumptions

- `feature-core` after 006 is the implementation base. 001–006 are complete and their data-safety behavior is not being redesigned.
- Sorakada remains Windows-first in 007; browser-only Vite rendering remains an important development mode.
- React 19, TypeScript, CodeMirror 6 and Tauri 2 remain the core technology stack.
- Base UI is acceptable as a headless behavior dependency only behind Sorakada-owned wrappers; it does not define the visual contract.
- A mature React virtualizer such as TanStack Virtual is acceptable and preferred over a handwritten virtualizer.
- Explorer structural rows use deterministic density-driven row metrics in 007; verbose load/error details may be truncated/tooltiped rather than expanding arbitrary row heights.
- The current single `EditorView` remains correct for the one-group implementation. `EditorGroup` is a structural seam only.
- Simple UI preference persistence may use a lightweight frontend storage adapter, but feature components never access storage directly.
- 007 may add the Tauri window permissions/configuration necessary for custom chrome. It does not introduce native filesystem or document IPC changes solely for UI.
- The final icon library is intentionally not selected in this feature; current/default glyphs may back the initial providers.
- The final default theme is intentionally not selected in this feature. Temporary/default token values are implementation scaffolding, not a frozen visual identity.

## Out of Scope / Deferred

- Full Settings page or Settings search/navigation
- Formal Theme Engine, Light/Dark theme switching or theme marketplace
- Monokai/Dracula/Nord/One Dark editor schemes
- Editor color-scheme import compatibility
- User-selectable UI/editor fonts and typography settings
- Glass/blur/transparency, background images and Appearance Profiles
- Smooth caret, spring/shared-layout animation and advanced motion system
- Theme plugins or arbitrary theme JavaScript execution
- File icon-theme selection and comprehensive special-file/language icon mappings
- UI Scale control beyond the density foundation
- Workspace Search/full-text search/index
- Git/source-control UI, branch detection/status and Git panel
- Split Editor, multiple live EditorGroups or multiple CodeMirror views
- Big/merged Tabs, per-group accent or per-Tab user color customization
- Tab drag/reorder, pinning, preview Tabs or multi-row Tabs
- Full keyboard shortcut/command customization spec
- Permanent Classic menu-bar preference / Alt-driven Classic menu mode
- Generic plugin contribution registry for panels, menus or status items
- Session/Recovery changes
- Encoding/EOL editing UI
- Rich line/column/language/indentation controls in Footer
