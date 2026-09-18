/**
 * The stable identifiers every application surface uses to invoke behaviour.
 *
 * Menu items, Explorer context menus, header buttons and keybindings all address
 * these IDs rather than calling document, Workspace or filesystem functions
 * directly, so every surface reaches the same handler and consults the same
 * availability predicate.
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
  // 003: shell.
  "view.toggleExplorer",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];
