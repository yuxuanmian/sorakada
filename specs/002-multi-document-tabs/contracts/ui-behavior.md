# Contract: Tab, Drag/Drop, and Window UI Behavior

**Feature**: `002-multi-document-tabs`

## Tab strip

Each Tab displays:

- document `displayName`
- dirty indication when dirty
- active styling when active
- close affordance
- full path as tooltip/title when path exists

Behavior:

- Clicking Tab body activates it and focuses editor.
- Clicking close must not also activate an inactive Tab as a side effect.
- Closing active Tab follows manager neighbor-selection rules.
- Horizontal overflow is supported; active Tab scrolls into view when necessary.
- No drag reorder, pinning, multi-row layout, split view, or advanced context menu in 002.

## Command surface

File menu includes:

```text
New
Open...
Save
Save As...
Close          Ctrl+W
---
Exit
```

`file.close` is a stable command id. Menu and keyboard dispatch through the same command registry as existing actions.

## Window title

Window title continues to reflect the active document only:

```text
Untitled3 - Sorakada
foo.txt - Sorakada
*foo.txt - Sorakada
```

Inactive dirty documents do not alter the window title until activated.

## Drag/drop affordance

Native desktop drag states:

```text
enter/over -> isFileDragActive = true
drop/leave -> isFileDragActive = false
```

When active, show a subtle overlay/border over the editing area. Use existing CSS variables/theme tokens; do not hard-code a theme-specific palette that cannot later be replaced.

On drop:

- process Tauri `paths` in provided order
- route to shared `openPath`
- directories ignored
- failures reported but batch continues
- duplicate activates existing
- last successful/duplicate-handled document becomes active

Browser-only Vite mode must not attempt to install native drag/drop listeners.

## Close window

- Native close request checks whether any document is dirty.
- If none: allow native close untouched.
- If any: prevent default, call `prepareCloseAll()` once, destroy window only on `true`.
- `app.exit` command uses the same close-all guard, then forced destroy to avoid close-request recursion.
