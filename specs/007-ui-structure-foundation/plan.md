# Implementation Plan: UI Structure Foundation

**Branch**: `007-ui-structure-foundation` | **Date**: 2026-09-19 | **Spec**: `specs/007-ui-structure-foundation/spec.md`

**Input**: Feature specification from `/specs/007-ui-structure-foundation/spec.md`

**Baseline**: `feature-core` commit `8c8a9488dc7dfdbd9a7c2bc6e206146b1d9db9f4`

## Summary

007 turns the current functional shell into Sorakada's long-lived UI foundation without attempting the final visual design.

The implementation will:

- convert the decorated Tauri window + native visible menu into a custom TopBar with compact in-WebView App Menu and safe native window controls;
- formalize `AppShell -> MainArea -> Sidebar + EditorWorkspace -> EditorGroup -> TabStrip + EditorHost`, plus an application-level Footer;
- introduce a Sorakada-owned UI primitive layer backed by Base UI for menus/context menus/portal behavior, keeping third-party components out of feature contracts;
- replace recursive Explorer DOM rendering with a flattened visible-row projection and TanStack React Virtual viewport;
- keep 006 filesystem laziness/watcher ownership intact while adding visible-only type-to-search, explicit Locate Current File, Collapse All, lower-prominence Refresh, horizontal overflow and IDEA-style indent guides;
- add `UiIconProvider`/`FileIconProvider` seams while retaining simple initial glyphs;
- redesign the TabStrip for many Tabs: one row, shrink-to-minimum, horizontal overflow, fixed New/Overview actions, active reveal and a lightweight searchable Tab Overview;
- add a full-width Footer with basic filesystem breadcrumb and existing format metadata;
- add small persisted UI preferences (density, Sidebar visibility/width) plus separate development-only virtualization diagnostics;
- preserve the current one-`EditorView` document architecture and all 001–006 data-safety/watcher contracts.

Final themes, Monokai/editor schemes, glass/blur, advanced motion, full Settings, split groups and rich icon-theme mappings remain deferred.

## Technical Context

**Language/Version**: TypeScript `~6.0.3`, React `^19.1.0`, Rust/Tauri 2 backend as currently locked in the repository

**Primary Dependencies**:
- Existing: React/ReactDOM, CodeMirror 6, `@tauri-apps/api`, Tauri dialog plugin
- New: `@base-ui/react` for headless Menu/ContextMenu/portal behavior behind Sorakada wrappers
- New: `@tanstack/react-virtual` for vertical Explorer virtualization

**Storage**:
- Existing filesystem/document storage unchanged
- New small frontend UI-preference payload via a versioned `UiPreferencesStore` adapter (density, Sidebar visibility, Sidebar width)
- Developer diagnostics remain process-local and are not persisted

**Testing**: Vitest for TypeScript/UI models/components where practical, existing Rust tests unchanged except quality-gate execution, manual Tauri/WebView2 acceptance for window chrome and cross-monitor/DPI behavior

**Target Platform**: Windows 10/11 desktop via Tauri/WebView2; browser-only Vite development remains supported

**Project Type**: Tauri desktop application with React frontend and Rust native backend

**Performance Goals**:
- With 10,000 materialized visible Explorer rows, steady-state mounted Tree rows stay below 200
- Tree DOM cost is viewport-bounded rather than visible-node-count-bounded
- Type-to-search issues zero filesystem reads
- Horizontal-width computation uses materialized UI data only and never scans disk
- 100 Tabs remain one row with reachable fixed actions and active-tab reveal
- Scroll/selection/Tab activation performs zero filesystem I/O and keeps mounted Explorer rows below the SC-001 bound under the acceptance fixtures

**Constraints**:
- CodeMirror remains sole owner of live document text
- `DocumentManager` remains owner of document metadata/path/dirty state
- `ExplorerController` remains owner of selection/expansion/inline-edit/reconciliation state
- 006 watcher/reconciliation remains the only automatic Workspace synchronization path
- No recursive Workspace traversal from UI code
- No full theme/settings/plugin subsystem
- No multi-EditorView/split implementation
- Third-party UI/virtualization dependencies must stay behind narrow Sorakada-facing boundaries
- Custom visual Close must not bypass the unsaved-work guard

**Scale/Scope**:
- Workspaces may contain 100,000+ descendants while only a bounded set is loaded
- A user can materialize 10,000+ visible Tree rows
- 100 open Tabs is an explicit UI acceptance scale
- Sidebar must be usable from the 640×400 configured minimum window through large 4K desktops
- Cross-monitor movement between a 2160p and 1080p display is a manual acceptance case

## Source Baseline and Code-Aware Findings

The plan is based on the pushed `feature-core` implementation, not only on the product discussion.

### Current shell

`src/app/shell/AppShell.tsx` currently renders:

```text
app
├── app__header (wordmark only)
└── app__body
    ├── Sidebar
    └── editor-area
```

`UiLayoutState` currently contains only transient `sidebarVisible` and `sidebarWidth`. 007 will keep the layout facts UI-owned, move them behind `UiPreferencesStore`, and expand composition to TopBar/MainArea/Footer/EditorWorkspace.

### Current Sidebar

`src/app/shell/Sidebar.tsx` manually resizes with a hard `SIDEBAR_MAX_WIDTH = 640`. That ceiling conflicts with 007's large-display requirement. 007 will calculate a maximum from the current shell width and minimum EditorWorkspace width rather than use a fixed 640px maximum.

The existing pointer-drag implementation is simple and testable, so there is no current need for a third resizable-panel dependency. It can be retained/refactored behind layout metrics unless implementation testing proves it inadequate.

### Current Explorer

`src/app/explorer/ExplorerTree.tsx` recursively renders `NodeRow` and hard-codes `INDENT = 14`. This is the central implementation point 007 must replace.

The filesystem/tree owner is already correctly separated: `ExplorerController` owns the tree model, selection, expansion, inline edit and reconciliation. 007 will not move those facts into React. A pure visible-row projection will sit between controller state and rendering.

The existing Explorer Header shows Workspace name plus New File/New Folder/Refresh. 007 will replace the visual header with `Files/Search + Locate + Collapse + More`; existing creation commands remain available from applicable menus/context surfaces and are not removed from the command model.

### Current context menu

`ExplorerContextMenu.tsx` is a custom fixed-position menu. It manually handles outside-click/dismiss behavior. 007 will migrate the menu surface to a Sorakada `SoraContextMenu` wrapper backed by Base UI while keeping `ExplorerActions`/command targeting unchanged. Prefer one controlled Explorer-level context-menu surface whose pointer event first captures row/root operation context; do not create an authoritative menu state per virtual row.

### Current TabBar

`src/app/tabs/TabBar.tsx`:
- is presentation-only, which is already correct;
- scrolls the entire strip;
- keeps `+` inside the scrolling content due to 004;
- uses one `activeTabRef`;
- does not implement shrink-to-minimum, fixed actions or overview.

007 keeps its presentation-only ownership, moves it under `EditorGroup`, separates the scroll viewport from fixed actions, and explicitly supersedes the 004 scrolling-`+` presentation.

### Current icons

`src/app/shell/AppIcon.tsx` already centralizes handwritten SVG paths. 007 should preserve that useful boundary but split semantics:
- `UiIconProvider` for shell/actions;
- `FileIconProvider` for filesystem entries.

The existing glyphs can implement the default providers; no icon-library selection is required in 007.

### Current styling

`src/styles/global.css` already centralizes the palette and several metrics. This is a good foundation and means 007 is not starting from a CSS free-for-all.

007 will:
- rename/extend tokens toward semantic structural/density roles where necessary;
- remove component-local layout magic such as `INDENT = 14`;
- keep temporary palette values centralized;
- avoid building the final Theme Engine.

### Current application menu and shortcuts

`src/app/menu/appMenu.ts` installs a native Tauri menu but all actions already dispatch stable `CommandId`s, and accelerator labels come from `ideaKeymap.ts`. That is exactly the command ownership 007 needs.

007 changes only the visible menu surface:
- compact WebView TopBar menu becomes primary;
- command registry and keymap remain unchanged;
- menu item enabled state still comes from the registry.

### Current window lifecycle

`src/app/window/windowLifecycle.ts` owns dirty-aware close interception and window-title synchronization.

The custom TopBar Close button MUST call the normal Tauri window `close()` request. It MUST NOT call `destroy()`, because `destroy()` bypasses close-request interception. The existing lifecycle may continue using `destroy()` only *after* the guard has approved the close.

### Current Tauri configuration

`src-tauri/tauri.conf.json` currently uses normal decorations. 007 custom chrome requires `decorations: false`.

`src-tauri/capabilities/default.json` currently grants set-title/destroy plus defaults. 007 must add only the window capabilities required by the new UI controls (for example close/minimize/maximize/start-dragging as required by the chosen Tauri API usage) while preserving existing permissions.

No Rust filesystem IPC change is required.

## Constitution Check

*GATE: Must pass before implementation. Re-check after design and before completion.*

| Constitution principle | 007 check |
|---|---|
| I. User Data Is Inviolable | **PASS**. UI Close goes through existing close request/guard; no document save/baseline semantics change. Explorer rendering/search does not mutate disk. |
| II. State Has One Owner | **PASS**. `DocumentManager`, `ExplorerController` and CodeMirror retain their ownership. New `UiPreferencesStore` owns only small UI preferences; `UiDebugOptions` remains separate. Virtual rows are projections, not state owners. |
| III. Contracts Are Verified From Both Sides | **PASS**. No filesystem/document IPC contract change is planned. Tauri window-capability/config changes receive manual desktop validation; all four repository gates still run. |
| IV. Commands Have One Execution Path | **PASS**. Compact menus, TopBar window actions and Explorer actions route through the command registry/canonical handlers. No menu-specific business logic is introduced. |
| V. Scope and Complexity Must Be Earned | **PASS**. Two dependencies are justified by current requirements: accessible/headless menu behavior and 10k+ row virtualization. Theme/settings/split/icon-theme systems are explicitly deferred. |

### Dependency justification

`@base-ui/react` is justified because 007 currently needs App Menu and Context Menu keyboard/focus/portal behavior and future 007 popups share the same overlay requirement. It is unstyled and composable, allowing Sorakada to retain its CSS contract instead of adopting a styled framework.

`@tanstack/react-virtual` is justified because virtualization itself is now a 007 requirement. Hand-writing scroll-windowing, ResizeObserver integration, offset calculations and active-item reveal would add more custom complexity than the dependency.

No animation, full UI framework, panel framework, icon theme library or settings framework is justified in 007.

## Technical Design

### 1. UI package boundary

Add a narrow Sorakada-owned primitive layer:

```text
src/ui/
├── overlay/
│   └── OverlayRoot.tsx
├── menu/
│   ├── SoraMenu.tsx
│   └── menuModel.ts
├── context-menu/
│   └── SoraContextMenu.tsx
└── primitives/
    └── (only primitives actually needed by 007)
```

Rules:

1. Only `src/ui/**` may import `@base-ui/react`.
2. Feature code imports Sorakada wrappers.
3. Wrapper props use Sorakada concepts (`items`, `commandId`, `disabled`, `label`, `icon`) rather than re-exporting Base UI's entire prop surface.
4. Base UI state attributes may be styled inside wrapper-owned CSS, but feature CSS must not target Base UI internals.
5. One overlay root/stacking context is established at app root. Base UI portals are routed/contained consistently.
6. Do not build an abstract "design system" beyond current use.

### 2. Custom TopBar / desktop chrome

Proposed files:

```text
src/app/shell/TopBar.tsx
src/app/shell/windowChrome.ts
src/app/menu/CompactAppMenu.tsx
```

Tauri desktop configuration:

```text
src-tauri/tauri.conf.json
  app.windows[main].decorations = false
```

Capability changes:

```text
src-tauri/capabilities/default.json
  + required window close/minimize/maximize/drag permissions
```

`windowChrome.ts` exposes a small testable interface:

```ts
interface WindowChromeController {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  requestClose(): Promise<void>; // calls window.close(), never destroy()
}
```

Browser fallback returns unsupported/no-op capability state so TopBar can hide/disable native controls.

The drag surface uses Tauri-supported drag regions. Interactive controls explicitly opt out. Avoid wrapping interactive buttons in an element that makes all descendants drag indiscriminately.

Double-clicking the non-interactive drag surface dispatches the same
`window.toggleMaximize` command used by the visible maximize/restore control.
The gesture handler must execute exactly once and must ignore events originating
from App Menu, window controls or any other interactive descendant.

No new title state owner is introduced: `installWindowLifecycle()` continues syncing the native title and guarding close requests.

### 3. Compact App Menu

Retire the native visible menu installation only when `CompactAppMenu` is wired and acceptance-ready; during incremental implementation it may remain temporarily so discoverability is not lost.

Reuse:
- `CommandRegistry`
- `CommandId`
- `acceleratorFor()`
- current command registration in `App.tsx`

Build a presentation model that groups existing commands. A menu item contains:

```ts
interface AppMenuItem {
  commandId: CommandId;
  label: string;
  accelerator?: string;
}
```

Enabled state is read at render/open time from the registry.

Add command ids only for newly visible 007 actions that actually execute behavior, such as:
- `window.minimize`
- `window.toggleMaximize`
- `window.close`
- `view.resetSidebarWidth`
- `view.densityCompact`
- `view.densityDefault`
- `view.densityComfortable`
- `explorer.locateCurrentFile`
- `explorer.collapseAll`

Debug-only toggles may use a separate developer surface if they are not product commands; if they are clickable user-visible menu items in a build, they should also route through stable command handlers.

Do not redesign the global keymap in 007.

### 4. AppShell composition

Refactor to:

```text
AppShell
├── TopBar
├── MainArea
│   ├── Sidebar
│   └── EditorWorkspace
│       └── EditorGroup
│           ├── TabStrip
│           └── EditorHost / EmptyState
└── FooterBar
```

Proposed files:

```text
src/app/shell/AppShell.tsx
src/app/shell/TopBar.tsx
src/app/shell/Sidebar.tsx
src/app/shell/EditorWorkspace.tsx
src/app/shell/EditorGroup.tsx
src/app/shell/FooterBar.tsx
src/app/shell/uiPreferences.ts
src/app/shell/uiDebugState.ts
```

`EditorGroup` is composition only in 007:
- no `EditorGroupId`;
- no GroupManager;
- no second editor handle;
- no new document ownership.

This is enough to stop TabStrip from becoming a global AppShell assumption while honoring Constitution V.

### 5. UiPreferences owner

`UiPreferencesStore` is the sole owner for:

```ts
type UiDensity = "compact" | "default" | "comfortable";

interface UiPreferences {
  version: 1;
  density: UiDensity;
  sidebarVisible: boolean;
  sidebarWidth: number;
}
```

Implementation rules:

- central default object;
- load once at application startup;
- validate types/ranges;
- malformed/unknown payload -> defaults;
- write through one adapter;
- components receive values/callbacks and never call `localStorage` directly;
- debug flags are not stored in this payload.

A small frontend storage adapter is sufficient; do not create a general Settings repository/service.

### 6. Density metrics

Root CSS/data attribute:

```text
[data-density="compact"]
[data-density="default"]
[data-density="comfortable"]
```

Define coordinated metrics such as:

```text
--tree-row-height
--tree-indent
--tree-chevron-size
--tab-height
--tab-min-width
--tab-max-width
--menu-item-height
--control-height
--ui-gap-*
```

Typography remains separate.

The virtualizer's estimated/fixed row height comes from the same resolved Tree row metric. On density change, virtualizer measurements and horizontal-width cache are invalidated.

Do not use `vw`/`vh` to linearly scale basic controls.

### 7. Sidebar width model

Replace fixed `SIDEBAR_MAX_WIDTH = 640`.

Keep:
- a fixed/sane minimum Sidebar width;
- a minimum EditorWorkspace width of 320 CSS logical pixels;
- dynamic maximum = `max(minSidebar, availableMainWidth - minEditorWidth)`.

For 007, `minEditorWidth` is frozen at `320` CSS logical pixels. It is a layout
boundary, not a physical-display heuristic; the value is applied after accounting
for the splitter and other fixed MainArea chrome. The configured 640×400 minimum
window is the narrow acceptance case.

Use ResizeObserver or equivalent shell measurement so the clamp updates when:
- window resizes;
- display/DPI changes alter logical viewport;
- Sidebar visibility changes.

`UiPreferences.sidebarWidth` stores the user's preferred logical width. Rendering clamps that preference against the current MainArea/editor bound, but passive clamping during a narrow window/display MUST NOT overwrite the preferred value; only an explicit user drag/reset updates it.

No separate resize dependency is needed unless implementation proves the current pointer-driven splitter cannot meet acceptance.

### 8. Explorer visible-row projection

Create a pure model layer, for example:

```text
src/app/explorer/explorerProjection.ts
```

Representative shape:

```ts
type VisibleExplorerRow =
  | {
      kind: "node";
      key: string;       // stable logical path/node key
      path: string;
      depth: number;
      node: ExplorerNode;
      ancestorContinuation: readonly boolean[];
    }
  | {
      kind: "notice";
      key: string;
      parentPath: string;
      depth: number;
      noticeType: "loading" | "error" | "cycle";
      message: string;
    };
```

`flattenVisibleExplorerRows(state)`:
- always starts at root when present;
- descends only through expanded children;
- never invokes service/controller I/O;
- produces deterministic row order matching existing sorted children;
- carries enough ancestor/depth information to draw indent guides.

The projection is derived on Explorer state changes and may be memoized by state/root identity where useful. Do not introduce a second mutable Tree model.

### 9. Explorer virtualization

Use `@tanstack/react-virtual` with the Explorer body as `scrollElement`.

Because React 19 is in use, start with `useFlushSync: false` unless current dependency testing demonstrates a better configuration; official TanStack guidance explicitly calls out React 19 lifecycle warnings as a reason to disable synchronous flush behavior.

007 should prefer fixed/density-driven row height for node and sentinel rows:
- predictable virtualization;
- simpler scroll-to-index;
- reliable density switches;
- no arbitrary error row height.

Long error details can be exposed through accessible title/overlay while the structural row remains fixed.

Use bounded overscan (plan default around 8–12 rows; tune with tests).

`ExplorerVirtualTree.tsx` receives only projection + callbacks. It never reads filesystem services.

Explorer focus must not live on recyclable row DOM. Keep one stable focusable Explorer/Tree viewport container for F2/Delete/type-to-search scope; clicking a row selects the logical path and returns focus to that stable container. Use `aria-activedescendant`/`aria-level` or equivalent accessible metadata where practical. `aria-activedescendant` may only name a mounted element, so the selected row is matched against the *exact* mounted index set rather than against its first-to-last span: the pinned inline-edit row (see below) makes that set non-contiguous, and an unmounted row inside the span would be named as if it existed.

Inline edit is the exception: its real input owns focus. Configure the virtual range/range extractor so the active inline-edit row stays mounted even if it leaves the normal viewport, preventing virtualization itself from firing the existing blur-cancel behavior. Once inline edit ends, ordinary viewport-only mounting resumes. The union that the extractor forms is one pure helper (`withPinnedIndex`), so the non-contiguous shape it produces is asserted without a browser.

### 10. Horizontal Tree extent under virtualization

Virtualization removes off-screen rows from DOM, so natural `scrollWidth` cannot represent the widest materialized row.

Add a UI-only width estimator:

```text
src/app/explorer/explorerTreeMetrics.ts
```

Inputs:
- current `VisibleExplorerRow[]`;
- depth/indent metrics;
- fixed affordance widths (chevron/icon/gaps/badges);
- current UI font signature;
- label text measurer.

Production label measurement can use a single Canvas 2D text measurement context or equivalent non-row DOM measurement. Tests inject a deterministic measurer.

Cache label widths by `(fontSignature, label)` and invalidate when density/font signature changes.

The virtual content layer receives a computed `min-width`/width sufficient for the current visible projection. This:
- enables horizontal scrollbar even if widest row is vertically off-screen;
- does not mount all rows;
- does not inspect disk;
- keeps Header outside the horizontal scroller.

### 11. Indent guides

Do not render nested DOM solely to obtain guide lines.

Each row uses:
- `depth`;
- `ancestorContinuation[]` or equivalent;
- CSS pseudo-elements/background layers/guide slots.

Guide color comes from semantic tokens and stays low contrast. Active-ancestor emphasis is deferred.

### 12. File/UI icon providers

Proposed:

```text
src/app/icons/iconTypes.ts
src/app/icons/uiIconProvider.ts
src/app/icons/fileIconProvider.ts
```

Default providers can wrap the current `AppIcon` path set.

`ExplorerRow` asks `FileIconProvider.resolve(node)`, not `iconFor(node)` with hard-coded extension branches.

`FileIconProvider` receives metadata only:
- name;
- kind;
- isSymlink;
- expanded for folders;
- optional path if later patterns need it.

No content reads.

### 13. Explorer Header / quick search

Split Explorer presentation into:
- `ExplorerHeader.tsx`
- `ExplorerQuickSearch.tsx` or a hook/controller local to UI
- virtual Tree viewport

Normal header:

```text
Files                          Locate  Collapse  More
```

Search header:

```text
[ query..................... ] Locate  Collapse  More
```

The right action container has fixed layout width so it does not jump.

Quick search is UI transient state:
- query;
- matched logical row keys;
- current match key if needed.

Search works only on `VisibleExplorerRow[]`; no service access. The current match is *selected* as
well as revealed, so arrow-key result navigation has a logical anchor rather than only a scroll
offset; the selection itself goes through the same routing decision every other selection gesture
takes, so with the development fixture rendered it stays fixture-local and never becomes a controller
path.

The initial direct-type trigger:
- only while Explorer owns focus;
- ignores Ctrl/Alt/Meta shortcuts;
- ignores `event.isComposing`/composition-owned input;
- never runs while inline rename/create input or popup text field owns focus.

Keep behavior modest in 007: case-insensitive name/path substring matching is sufficient; fuzzy-search engine is not required.

### 14. Locate Current File

Add one explicit command/action path.

The action coordinator uses:
- current active `DocumentSession`;
- current `WorkContext`;
- existing filesystem-aware relation/identity data;
- `ExplorerController`.

Algorithm:

1. reject untitled/no active/no Workspace;
2. prove the active file is inside the current Workspace using existing canonical relation semantics;
3. derive the exact relative path/ancestor components;
4. starting at represented root, expand/reconcile only the next known ancestor at each level if required;
5. abort safely if a component is missing/unreadable/stale;
6. select target and ask virtual viewport to reveal its logical index.

Do not search by filename and do not read siblings beyond each direct listing already required to find the next component.

If the active path changes while the async reveal is in flight, generation/document identity checks discard stale intent.

### 15. Collapse All / Refresh

`explorer.collapseAll` mutates only Explorer expansion via controller API; it does not change documents.

Refresh remains the existing `explorer.refresh` command and 006 reconciliation implementation. Only its placement changes: More/context menu, not primary header button.

### 16. TabStrip / many Tabs

New composition:

```text
TabStrip
├── TabViewport (horizontal scroll)
│   └── Tab[]
└── TabActions (fixed)
    ├── TabOverview (when overflow / useful)
    └── New
```

Tab CSS:
- one row;
- `max-width` token;
- `min-width` token;
- flex shrink down to min;
- overflow after min.

Use a scroll helper that takes the actual viewport and tab element bounds; do not rely on `scrollIntoView()` if it can scroll an outer container or hide content behind fixed actions.

The action region is outside the scrolling element, so New never disappears.

Both boxes are observed, not only the strip: showing the Overview control widens the *action region*
without changing the strip's own width, and a density transition resizes those controls the same way.
The observed sizes are the only inputs to one pure solve (`solveTabStrip`), so a Tab viewport that is
too wide — the state that lets New/Overview cover a Tab — cannot survive a size change of either box.
`overflows` is monotone in the viewport width, so the extra pass the Overview costs settles instead of
oscillating.

### 17. Tab Overview

Implement as a Sorakada popup wrapper:
- derives list from `DocumentManagerSnapshot.tabs`;
- input filters `displayName` and `path`;
- preserves current tab order;
- marks active/dirty/external state;
- selecting item calls the same `manager.selectDocument(id)` path;
- no own document state;
- no tab reorder/close management in 007 unless current close action is trivially reused and explicitly tested.

Overview visibility can be driven by a ResizeObserver/scrollWidth check. New remains always visible.

### 18. Footer

`FooterBar` is full-width after MainArea.

Left projection:
- active inside-workspace document -> Workspace display name + relative path components;
- active outside document -> compact filesystem path components;
- Untitled -> display name;
- no active doc + Workspace -> Workspace root/display name;
- no active doc/no Workspace -> empty/minimal application state.

Containment MUST come from already-canonical identities, not lexical strings. A practical synchronous projection is:
1. compare `WorkContext.comparisonKey` with `DocumentSession.pathIdentity.comparisonKey` through the existing component-aware `relativeWithinDirectory()` helper;
2. use the relative canonical component count only to establish relation/depth;
3. take the corresponding trailing components from the user-facing `session.path` for display casing/spelling.
If implementation instead reuses `resolveWorkspaceRelation`, keep it a bounded per-active-path relation request and cache/guard it; never scan the Workspace.

It is read-only; no automatic Explorer selection.

Right projection:
- current format data already owned by `DocumentSession`, initially e.g. `UTF-8`, `LF`/`CRLF`;
- omit when no document;
- no editing controls.

Footer layout uses:
- left flex/truncate;
- right non-wrapping prioritized items;
- no MainArea overlap.

Line/column/language/indent controls are deferred because they require additional live editor/status contracts not needed to establish the Footer.

### 19. CSS organization

Retain existing CSS files where sensible but make responsibilities explicit:

```text
src/styles/
├── global.css       # palette/semantic baseline + typography
├── density.css      # compact/default/comfortable structural metrics
├── shell.css
├── explorer.css
├── tabs.css
├── footer.css       # if split from shell
└── ui.css / wrapper-local CSS as appropriate
```

Rules:
- palette literals only in central token declarations;
- feature CSS consumes variables;
- no `!important` as normal override strategy;
- no selectors that depend on Base UI generated/internal class names;
- wrappers own Base UI state-attribute styling;
- final theme naming/JSON/plugin format is deferred.

### 20. Overlay/stacking model

Establish explicit layers, for example:

```text
base content
window chrome
transient UI
popup/tooltip/context menu
modal (future)
```

Do not scatter arbitrary `z-index: 9999`.

Base UI's portal model should terminate in/above one application stacking context so Sidebar `overflow` cannot clip popups.

### 21. Debug/acceptance instrumentation

Development-only UI debug projection:
- visible row count;
- virtual rendered row count;
- start/end virtual indexes;
- optional row bounds/range overlay.

This reads virtualizer/projection state only.

Do not persist it.

The two scale harnesses (10,000 Explorer rows, 100 Tabs) are development-only and disposable. Their
isolation rule is part of their contract rather than a UI convention: the Explorer fixture is
recognised by its own context marker, its selection and operation target are UI state owned by the
Explorer, and every selection gesture is routed by that marker, so no fixture path can become
controller state or reach an Explorer action; the Tab fixture owns its active Tab and its ids never
reach `DocumentManager`. The Explorer's `aria-activedescendant` is derived from exact membership in
the mounted virtual-item set, because a pinned off-screen inline-editor row makes that set
non-contiguous.

Density controls are ordinary preferences and remain available outside debug builds.

### 22. Browser/Tauri split

`App.tsx` already detects Tauri runtime. Reuse that distinction.

Desktop:
- custom window controls;
- window drag behavior;
- compact menu;
- all editor functionality.

Browser-only:
- same AppShell, Explorer, Tabs, Footer, menus;
- no native window control calls;
- controls hidden/disabled;
- no startup crash from importing/invoking unavailable APIs.

### 23. No Rust filesystem redesign

007 should not modify:
- file codec;
- filesystem watcher semantics;
- workspace read IPC payloads;
- path identity;
- delete/rename/create wire contracts.

Tauri JSON capability/config updates are expected, but Rust source changes should only occur if the current Tauri shell integration makes a narrowly justified window-chrome adjustment unavoidable.

## Project Structure

### Documentation (this feature)

```text
specs/007-ui-structure-foundation/
├── spec.md
├── plan.md
└── tasks.md
```

The packaged planning bundle may additionally contain `consistency-check.md` as analysis evidence; it is not one of the three Speckit feature documents.

### Source Code (repository root)

```text
src/
├── app/
│   ├── App.tsx
│   ├── commands/
│   │   ├── commandIds.ts
│   │   ├── commandRegistry.ts
│   │   └── ideaKeymap.ts
│   ├── explorer/
│   │   ├── Explorer.tsx
│   │   ├── ExplorerHeader.tsx                  # new
│   │   ├── ExplorerVirtualTree.tsx             # new / replaces recursive render path
│   │   ├── explorerProjection.ts               # new
│   │   ├── explorerTreeMetrics.ts              # new
│   │   ├── explorerController.ts
│   │   ├── explorerActions.ts
│   │   └── explorerModel.ts
│   ├── icons/                                  # new semantic provider boundary
│   │   ├── iconTypes.ts
│   │   ├── uiIconProvider.ts
│   │   └── fileIconProvider.ts
│   ├── menu/
│   │   ├── CompactAppMenu.tsx                  # new
│   │   └── appMenu.ts                          # retire/remove visible native install
│   ├── shell/
│   │   ├── AppShell.tsx
│   │   ├── TopBar.tsx                          # new
│   │   ├── Sidebar.tsx
│   │   ├── EditorWorkspace.tsx                 # new
│   │   ├── EditorGroup.tsx                     # new
│   │   ├── FooterBar.tsx                       # new
│   │   ├── EmptyState.tsx
│   │   ├── windowChrome.ts                     # new
│   │   ├── uiPreferences.ts                    # new
│   │   └── uiDebugState.ts                     # new
│   └── tabs/
│       ├── TabStrip.tsx                        # new/renamed from TabBar
│       └── TabOverview.tsx                     # new
├── editor/
│   └── ...                                     # existing one-EditorView design preserved
├── styles/
│   ├── global.css
│   ├── density.css                             # new
│   ├── shell.css
│   ├── explorer.css
│   ├── tabs.css
│   └── footer.css                              # optional separate file
└── ui/                                         # new Sorakada-owned primitive layer
    ├── overlay/
    │   └── OverlayRoot.tsx
    ├── menu/
    │   └── SoraMenu.tsx
    └── context-menu/
        └── SoraContextMenu.tsx

src-tauri/
├── capabilities/default.json                   # window permissions
└── tauri.conf.json                             # decorations: false

package.json
package-lock.json
```

Tests remain colocated with the existing TypeScript style:

```text
src/app/**/**.test.ts(x)
src/ui/**/**.test.ts(x)
```

No new backend test project is introduced.

**Structure Decision**: Keep the existing single frontend/native desktop project. Add narrow UI-model/component modules around existing state owners rather than creating a generic UI framework package or a parallel application state store.

## Data and State Ownership

| Fact | Authoritative owner |
|---|---|
| Document text/selection/history | CodeMirror `EditorState` / existing editor bridge |
| Document identity/path/dirty/external state | `DocumentManager` |
| Workspace identity | `WorkContextManager` |
| Tree nodes/selection/expansion/inline edit/reconciliation | `ExplorerController` |
| Flattened visible rows | Derived projection only; no independent mutation |
| Virtual range/scroll measurements | `ExplorerVirtualTree` / virtualizer UI state |
| Tab document metadata | `DocumentManagerSnapshot` |
| Tab viewport/overview open/filter state | Tab UI only |
| Density/Sidebar visibility/width | `UiPreferencesStore` |
| Debug overlays/counters | `UiDebugOptions` / dev-only UI state |
| Footer values | Derived from existing Workspace/document metadata |
| Window close permission | Existing `windowLifecycle` + `DocumentManager.prepareCloseAll()` |

No 007 implementation may create a second authoritative copy of an existing fact.

## Error and Stale-Result Rules

- Window-control failures are surfaced through the existing application error reporting path where meaningful; they do not mutate document state.
- Locate Current File captures active document id/path + WorkContext id/generation. If either changes before reveal settles, the reveal is stale and cannot select a wrong node.
- Type-to-search stores logical row keys/paths, not array indexes as identity.
- Watcher reconciliation changing `VisibleNodeList` invalidates search match indexes and Tree width metrics but does not touch the controller's authoritative state.
- Preference parse failure returns defaults.
- File icon resolver failure/unknown mapping returns fallback glyph.
- Virtualizer calculation failure must not trigger filesystem reads; fallback may render a bounded safe state but not all 100k descendants.
- Browser runtime never attempts unavailable Tauri window IPC.

## Testing Strategy

### Pure model tests

High-value deterministic tests should cover:

- visible-row flattening for expanded/collapsed/error/loading/cycle states;
- depth/ancestor-guide metadata;
- no callback/service access from flattening;
- quick-search matching and stale-match recomputation;
- Sidebar dynamic clamp math;
- preference validation/migration/fallback;
- Tree horizontal width estimation with injected text measurer;
- file icon provider fallback;
- Tab overview filtering;
- Footer breadcrumb derivation;
- command/menu model availability.

### Component/DOM tests where current test environment supports them

- virtual rendered-row count versus 10k projection;
- active Tab reveal helper and overflow detection;
- fixed Tab action region;
- Base UI wrapper menu command dispatch exactly once;
- Explorer direct-type activation exclusions;
- custom TopBar interactive/drag markers.

Do not force brittle pixel-perfect snapshot tests for the temporary 007 visual styling.

### Existing regression suites

All existing document, Explorer, watcher and Rust tests remain mandatory. 007 should add regression tests around every code path it changes instead of weakening existing assertions.

### Manual desktop acceptance

Manual acceptance is mandatory for behavior WebView/Vitest cannot adequately prove:

1. custom undecorated window visually has no duplicate native title/menu strip;
2. TopBar drag, double-click maximize/restore, minimize, maximize and close;
3. dirty-close Cancel keeps window/document alive;
4. browser-only dev fallback renders;
5. Sidebar drag across narrow/large windows and >640px width;
6. 10k+ visible-row virtual fixture scroll/selection/context menu;
7. long/deep Tree horizontal scrollbar while Header remains fixed;
8. many Tabs (100) with overflow, active reveal, Overview and fixed New;
9. 2160p ↔ 1080p monitor move, especially with different Windows scaling;
10. Compact/Default/Comfortable density switching after cross-monitor move;
11. popup/context-menu positioning near every window edge;
12. Footer states for Workspace-only, untitled, inside file and outside file.

## Implementation Sequence

### Phase 0 - Baseline and dependency pinning

- Record the `feature-core` baseline and run all four gates before UI changes.
- Add Base UI and TanStack Virtual with lockfile update.
- Do not add optional theme/icon/animation libraries.

### Phase 1 - Foundational UI boundaries

- Create semantic UI wrapper/overlay layer.
- Create preference/debug owners.
- Establish density token file.
- Split icon providers from glyph rendering.
- Add command ids needed by visible 007 actions.

This phase blocks feature UI migration because later components must not import dependencies directly.

### Phase 2 - AppShell/custom chrome

- Refactor shell hierarchy.
- Add TopBar/window controls/compact menu.
- Disable native window decorations and update capabilities.
- Preserve lifecycle and browser fallback.
- Add Footer and EditorGroup composition seam.

### Phase 3 - Menu and overlay migration

- Wire the compact App Menu only after its Sorakada wrappers and command model exist.
- Migrate the current Explorer context-menu surface to the shared wrapper while
  preserving its controlled Explorer-level operation target.
- Retire the visible native menu only after the compact menu is acceptance-ready.

This phase intentionally precedes Tree virtualization. The controlled
Explorer-level context target is then reused by the virtual renderer rather than
creating authoritative popup state inside recyclable rows.

### Phase 4 - Explorer projection + virtualization

- Build/test `VisibleNodeList`.
- Introduce virtual viewport with fixed density row metrics.
- Migrate all row interactions/inline edit/context menu.
- Add indent guides and horizontal extent estimator.
- Verify no 004/006 regressions.

### Phase 5 - Explorer navigation/header

- New Header.
- Quick search.
- Locate exact path.
- Collapse All.
- Move Refresh to More.
- Migrate context menus to Sorakada/Base UI wrapper.

### Phase 6 - TabStrip scalability

- Move TabStrip into EditorGroup.
- Separate scrolling viewport and fixed actions.
- Add shrink/min/overflow behavior.
- Add active reveal.
- Add Tab Overview/filter.

### Phase 7 - Footer + preferences/debug

- Populate breadcrumb/format projection.
- Persist density/Sidebar preferences.
- Add View menu density/reset entries.
- Add dev-only virtualizer diagnostics.

### Phase 8 - Cross-cutting validation

- Run scale fixtures.
- Cross-DPI/window acceptance.
- CSS boundary audit.
- All four repository quality gates.
- Re-run Constitution Check and specification consistency audit.

## Post-Design Constitution Re-check

The chosen design still passes all five principles:

- No data lifecycle logic moved into UI.
- New UI state has explicit owners.
- No document/filesystem IPC contract is changed.
- New visible actions get command paths rather than direct feature behavior.
- Base UI and TanStack Virtual are each tied to a concrete 007 requirement and are not used as excuses to build speculative frameworks.

No exception is requested.

## Complexity Tracking

No Constitution violations or approved exceptions are required.

The main new complexity is deliberate and requirement-backed:
- one headless primitive dependency for accessible popup behavior;
- one virtualizer dependency for required large-Tree scalability;
- one small UI preference owner;
- a custom titlebar that replaces, rather than duplicates, the current visible native chrome.

Everything broader (theme engine, Settings framework, panel registry, split manager, icon theme framework, animation framework) remains deferred.

## Implementation Evidence (007 execution)

### Dependency note (T005)

`@base-ui/react@^1.8.0` and `@tanstack/react-virtual@^3.14.13` are the only two runtime
dependencies 007 adds:

- **Base UI** implements accessible, keyboard-complete, portal-aware popup behaviour for the
  compact App Menu, the Explorer context menu and the Tab Overview. It is headless and unstyled,
  so Sorakada keeps its own DOM wrappers and CSS contract instead of adopting a styled framework
  (FR-013, FR-014, FR-097). It is imported only through the three Sorakada wrappers under
  `src/ui/**`, and only from the documented `menu`, `context-menu` and `popover` entry points —
  both rules are enforced by `src/ui/boundaries.test.ts`.
- **TanStack Virtual** implements the 10,000-row Explorer windowing 007 now requires. A
  handwritten scroll-windowing implementation would carry more custom complexity than the
  dependency. It is imported by exactly one module, `src/app/explorer/ExplorerVirtualTree.tsx`.

No animation, theme, panel, icon-theme, settings or icon-library dependency was added (FR-097).

### Static inventory record (T006)

The one-time pre-migration scan found no pre-existing violation in the 007-owned surface: no
`!important`, no `:deep(...)` and no dependency-internal selector anywhere in `src/`; palette
literals existed only in `src/styles/global.css`; and the only ad-hoc `z-index` values were
`src/styles/shell.css` (`2`, the resizer) and `src/styles/explorer.css` (`10`, the custom context
menu). Both were replaced by the named layer tokens, and `src/ui/cssContract.test.ts` now fails on
any of these patterns reappearing outside the central token layer.

### Constitution re-check (T214)

| Principle | 007 result |
|---|---|
| I. User Data Is Inviolable | **PASS.** The visual Close control dispatches `window.close` → `WindowChromeController.requestClose()` → the ordinary close request → `installWindowLifecycle()`. `windowChrome.ts` has no destroy-shaped operation at all, and `src/app/shell/uiFoundationAudit.test.ts` pins that the only force-destroy path is application Exit, after the guard approved it. No document, baseline or format semantics changed. |
| II. State Has One Owner | **PASS.** `DocumentManager`, `WorkContextManager`, `ExplorerController` and CodeMirror keep their facts. The two new owners are `UiPreferencesStore` (density + Sidebar layout) and the process-local `UiDebugOptionsStore`. Visible rows, Tree extent, Footer values and Tab Overview entries are derived projections; the virtual range is reported, never stored. |
| III. Contracts Are Verified From Both Sides | **PASS.** No document/filesystem IPC contract changed. The two-sided contracts that did change are pinned from both sides: density metrics (`density.ts` ↔ `density.css`), the Editor minimum and splitter width (`layoutMetrics.ts` ↔ `global.css`), and the window-chrome close path (pure controller + lifecycle integration test). All four gates pass. |
| IV. Commands Have One Execution Path | **PASS.** Every new visible control dispatches a stable `CommandId` through the same registry: TopBar window controls, the compact menu, the Explorer Header/More/context menu, the density and Sidebar-preferences entries and the debug toggles. `src/app/menu/menuActivation.test.ts` pins one activation → at most one command. |
| V. Scope and Complexity Must Be Earned | **PASS.** Two justified dependencies; three thin wrappers; one small preference owner; no Settings page, theme engine, split editor, plugin registry or Session/Recovery redesign. The one added surface beyond the original file list (`SoraPopover`) exists because FR-069/T139 require a filterable list popup, which a menu surface cannot host. |

No Constitution violation or approved exception remains open.

### Implementation decisions recorded for review

These are places where the specification required a choice, not a departure from it:

1. **Window dragging** uses the Tauri `startDragging()` window API from a non-interactive surface
   with an explicit interactive opt-out (`data-sora-interactive`), instead of the
   `data-tauri-drag-region` attribute. The attribute's own double-click maximize would fire *in
   addition* to the canonical `window.toggleMaximize` command FR-007 requires exactly once, so the
   gesture is owned by `src/app/shell/topBarGesture.ts` and the capability list grants
   `core:window:allow-start-dragging` (T041).
2. **`SoraPopover`** was added as a third Sorakada wrapper (Base UI `popover`) because the Tab
   Overview needs an input plus a selectable list inside its popup.
3. **`ExplorerController.collapseAll()`** additionally cancels an inline editor whose row the
   collapse just hid, because the user explicitly dismissed the row the draft belonged to; cached
   children, load state and selection are deliberately untouched.
4. **Vitest `css: true`** was enabled in `vite.config.ts` so the CSS-contract audit can read the
   real stylesheet text (`?raw`) instead of Vitest's stubbed empty CSS module.
5. **Two development-only commands** (`view.debugLargeTree`, `view.debugManyTabs`) expose the
   shared T008/T009 fixtures through the debug submenu (T182, T183).

### 007 debug workflow (T185)

Everything below runs in a development build (`npm run dev`, or `tauri dev` for the desktop shell):

1. **Density** — TopBar `Sorakada ▾` → View → Density → Compact / Default / Comfortable. The root
   `data-density` attribute changes and every structural metric (Tree row height/indent, Tab
   height/min/max, menu item height, control height, TopBar/Footer height) follows. Typography does
   not change; the Editor, `DocumentManager` and `ExplorerController` are not remounted.
2. **Reset Sidebar width** — View → Reset Sidebar Width restores the density default through
   `UiPreferencesStore`.
3. **Virtualization counters** — View → UI Debug → Virtual Range shows `visible`, `rendered` and
   the current virtual `start–end` indexes in a strip under the Explorer Header. Virtual Range off
   renders no element at all, so the Tree geometry is untouched.
4. **Row bounds** — View → UI Debug → Tree Row Bounds outlines each mounted row, which makes the
   windowed range visible at a glance.
5. **10,000-row Tree** — View → UI Debug → 10,000-Row Tree replaces the rendered Explorer state
   with the shared T008 fixture. The fixture is *isolated*, not merely read-only: clicking, right
   clicking and quick-searching inside it move the fixture's **own** selection (UI state of the
   Explorer) and never write a fixture path into `ExplorerController`, while the controller's real
   selection is left exactly as it was. Because the fixture is not a Workspace, the harness renders
   without one: its own root name is shown in the Header, the Header offers no real-Workspace actions,
   F2/Delete dispatch nothing, and no context menu is presented (the gesture target is still
   recorded). The counters above then report how few rows are mounted.
6. **100 Tabs** — View → UI Debug → 100 Tabs feeds the shared T009 `TabSnapshot[]` fixture to the
   TabStrip and forces the Overview control on, so the shrink/overflow/Overview behaviour is
   inspectable without creating files. While it is enabled the fixture owns its own active Tab:
   clicking a Tab or choosing one in the Overview moves that marker (and therefore runs the strip's
   reveal rule), and closing one is a harmless list operation. Fixture ids are `fixture-doc-N`, which
   `DocumentManager` never sees — a Tab gesture is routed by identity, so no fixture id can reach a
   document session even if the fixture is switched off between the gesture and the update.

Debug controls are omitted from a production menu (`buildAppMenuModel({developer: false})`); the
density and Sidebar preference commands remain available there.

### Consistency pass (T215)
Every FR and SC in `spec.md` maps to a task phase, and the mapping table in `tasks.md` was checked
against the implementation: no FR is unimplemented, no SC lacks an automated or explicitly recorded
manual check, and no deferred 008 scope (theme engine, Settings, split groups, Git, workspace
search, icon themes, Tab drag/reorder) was pulled forward. The superseded contracts SR-001..SR-006
are all reflected: fixed New action (TabStrip), de-emphasised Refresh (`More`), explicit Locate,
populated Footer, persisted Sidebar preference, retired native menu.

### Defect found during desktop verification, and fixed

Launching the desktop shell surfaced a refusal that the automated gates could not have caught:

```text
window.set_title not allowed on window "main", webview "main", URL: local

allowed on: [URL: local]
```

Two causes were found; both are fixed and both now have regression coverage.

1. **Lost capability scope.** The rewritten `src-tauri/capabilities/default.json` had dropped the
   baseline `"windows": ["main"]` field. A Tauri capability that grants a `core:window:*`
   permission while specifying neither `windows` nor `webviews` resolves to a command whose window
   and webview pattern lists are **empty**, and the ACL check is

   ```rust
   resolved.webviews.iter().any(|w| w.matches(webview))
     || resolved.windows.iter().any(|w| w.matches(window))
   ```

   so both sides are `false` and *every* window permission in the capability is denied — including
   `set-title`, `close`, `minimize`, `toggle-maximize`, `is-maximized` and `start-dragging`. The
   field is restored, and the regenerated `src-tauri/gen/schemas/capabilities.json` now reads
   `"windows":["main"]`. `src/app/window/capabilityContract.test.ts` pins the scope, the
   local-URL setting and the exact window-permission set, so the scope cannot be dropped silently
   again (T041, T213).
2. **A cosmetic title failure could remove the close guard.** `installWindowLifecycle()` awaited the
   initial `setTitle` unprotected, so a refused title write rejected *before* `onCloseRequested`
   was registered — silently leaving the window with no dirty-close interception at all, which
   FR-008 forbids. Every title write is now best-effort and reported through `onError`, and
   `App.tsx` reports a native-surface failure through the existing error path instead of letting it
   become an unhandled rejection. `windowLifecycle.test.ts` proves the guard is still installed,
   still blocks the close and still runs `prepareCloseAll()` exactly once when the title write is
   refused.

Re-verified after the fix: `npm run typecheck`, `npm run test`, `npm run build` and `cargo test`
(145 tests) are all green, and the built `capabilities.json` carries the correct window scope. The
desktop smoke that confirms the window controls end to end (`T057`/`T217`) was performed by the
maintainer as part of the manual acceptance review recorded in `tasks.md`.

### Defect found during desktop verification: Tab width

The desktop run also showed a single Tab for `package-lock.json` rendered about 220 logical pixels
wide, with a dead gap between the close button and the Tab's right edge. Two causes:

1. **The maximum was used as a default.** `computeTabLayout` returned `tabWidth = maxWidth`
   whenever `tabCount * maxWidth <= viewportWidth`, so *every* Tab reserved the comfortable
   maximum regardless of its name. FR-065 makes the maximum a **ceiling** ("shrink from a
   comfortable maximum"), never a default width.
2. **`.tab__label` did not grow.** Without `flex: 1 1 auto` the label kept its content width and
   all slack collected *after* the close button, which is what made the gap visible.

The layout is now content-sized: `naturalTabWidth` = measured label + the Tab's fixed
padding/gap/close geometry, clamped to `[tabMinWidth, tabMaxWidth]`; Tabs keep their own widths
while they all fit, are squeezed to **one** uniform width (down to the minimum) once they do not,
and only then does the viewport scroll — one row throughout. `.tab__label` now takes the remaining
width, so the close button sits at the Tab's right edge even when the minimum applies. The active
Tab reveal uses per-Tab left offsets (`tabOffsets`) rather than an index-times-width product.

A third, related defect was found while fixing this one: the label measurer read the UI font from
`<html>`, where the UI font is **not** declared (`body` owns `--font-ui`/`--font-size-ui`), so every
measured label was sized in the browser's default font. `readUiFontSource()` now reads `<body>`,
which corrects both the Tab widths and the Tree's horizontal extent. The measurement primitive was
extracted to `src/app/shell/textMeasurement.ts` so the Tree and the Tab strip share one
implementation instead of two copies.

Regression coverage: `tabStrip.test.ts` pins the content-sized width (including the exact
`package-lock.json` case: 148px, not 220px), the marker reservations, the density bounds, the
uniform squeeze, the minimum-then-overflow behaviour and variable-width reveal arithmetic.

### Defect found during desktop verification: Locate Current File

Locate appeared to do nothing when the opened file's parent folder was not currently visible in the
Tree. The walk required every ancestor to be **loaded**, but the visible-row projection only
descends through **expanded** directories:

- an ancestor that had been read and then collapsed was found in the cache, so the walk returned
  `located` and selected a path that had no row to reveal — and the reveal request was then cleared
  anyway, because the Tree discarded it whenever the row was absent from the projection;
- a collapsed *root* hid everything below it, including a direct child;
- a locate issued while a directory read was still in flight (`loading` with no children yet) gave
  up immediately instead of waiting for that read to settle;
- a file that appeared after its directory had been read (a build step, an external create) was not
  found, because the cached listing was used as-is.

`locateCurrentFile` now has one documented level helper, `ensureLevelAvailable`, which handles the
three states that actually differ: a never-read directory is loaded (the canonical expansion), a
read-but-collapsed directory is expanded without re-reading anything, and an in-flight read is
waited out with `whenIdle()` so no second read is started. Every ancestor on the chain — including
the represented root — is expanded as well as loaded, because that is what the projection needs. If
the target is still missing from an already-read directory, Locate performs **exactly one** bounded
re-read of that file's own directory before giving up, which covers the stale-cache case without
ever walking a sibling branch. The Tree additionally keeps a reveal request pending until its row
actually exists in the projection (`planRowReveal`) instead of dropping it on the first render.

Regression coverage in `explorerNavigation.test.ts`: loaded-but-collapsed ancestors, a collapsed
root, an in-flight root read, a file created after its directory was read, the bounded read set with
zero sibling reads, and the pre-existing depth-N chain test. `explorerProjection.test.ts` pins the
pending-reveal rule.

### Defect found during desktop verification: first App Menu open was all greyed out

Opening the compact App Menu for the first time after launch showed every entry disabled. The cause
is render timing, not availability logic: command availability is read from `CommandRegistry`, and
the registry is filled in the application's **mount effect** — i.e. after the first render. The first
render therefore built the menu model from an empty registry, in which `isEnabled` answers `false` for
every id, and nothing re-rendered the shell before the first click, so the popup opened with that
stale all-disabled model.

Two complementary changes:

1. **`CompactAppMenu` owns the popup's open state.** Opening is a state change in that component, so
   the model is rebuilt at exactly the moment the popup appears, from the registry as it is then —
   which also keeps an already-open popup current, because every availability input (document
   snapshot, Workspace, Explorer state) re-renders the shell anyway. Base UI's trigger click is
   routed through its `setOpen` open-change pipeline, so the controlled prop and `onOpenChange` are
   the path a trigger takes; the menu still opens exactly as before.
2. **The shell re-renders once registration completes** (`commandsRegistered`), so the state "no
   command exists yet" is gone before anything can be interacted with — mount effects run before the
   user can click.

Regression coverage in `appMenuAvailability.test.ts`: an empty registry really does disable every
entry (the stale state), the model re-reads availability on every build, a registry-refused command
stays disabled while the rest do not, and a source audit proves every command any menu surface can
name (`buildAppMenuModel` including the debug submenu, `explorerHeaderActions`,
`buildExplorerMoreMenuModel`, `EXPLORER_MENU_ACTIONS`) is actually registered in `App.tsx` and that
`App.tsx` registers no id outside the declared catalogue (FR-096).





