/**
 * The stable identifiers every application surface uses to invoke behaviour.
 *
 * Menu items and (later) custom keybindings address these IDs rather than
 * calling document or file functions directly, so the surfaces can be replaced
 * without touching the lifecycle logic.
 */
export const COMMAND_IDS = [
  "file.new",
  "file.open",
  "file.save",
  "file.saveAs",
  "app.exit",
  "editor.undo",
  "editor.redo",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];
