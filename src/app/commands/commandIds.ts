/**
 * The stable identifiers every application surface uses to invoke behaviour.
 *
 * Menu items, Explorer context menus, header buttons, TopBar window controls and
 * keybindings all address these IDs rather than calling document, Workspace or
 * filesystem functions directly, so every surface reaches the same handler and
 * consults the same availability predicate.
 *
 * 007 adds ids only for actions it actually makes visible (FR-096). The keymap
 * profile is deliberately unchanged: none of the new ids receives a global
 * accelerator (T031).
 */
export const COMMAND_IDS = [
  "file.new",
  "file.open",
  "file.save",
  "file.saveAs",
  "file.close",
  "app.exit",
  "editor.undo",
  "editor.redo",
  // 003: Workspace lifecycle.
  "workspace.openFolder",
  "workspace.closeFolder",
  // 003: Explorer filesystem operations. These are also the operations the
  // Explorer-local F2/Delete handler dispatches; they are deliberately *not*
  // global keymap entries.
  "explorer.newFile",
  "explorer.newFolder",
  "explorer.rename",
  "explorer.delete",
  "explorer.refresh",
  // 007: Explorer navigation. Locate is now an explicit user request (SR-003);
  // Collapse All only changes Tree expansion (FR-054).
  "explorer.locateCurrentFile",
  "explorer.collapseAll",
  // 003: shell.
  "view.toggleExplorer",
  // 007: density and Sidebar layout preferences (FR-088).
  "view.resetSidebarWidth",
  "view.densityCompact",
  "view.densityDefault",
  "view.densityComfortable",
  // 007: development-only diagnostics. Clickable menu items route through the
  // same registry as everything else (FR-096, T065).
  "view.toggleVirtualRange",
  "view.toggleTreeRowBounds",
  // 007: the development-only scale harnesses. They feed the UI the shared
  // disposable fixtures, never a real filesystem enumeration (T182, T183).
  "view.debugLargeTree",
  "view.debugManyTabs",
  // 007: custom window chrome. The visual controls dispatch these instead of
  // calling the native window directly (FR-007, FR-008).
  "window.minimize",
  "window.toggleMaximize",
  "window.close",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];
