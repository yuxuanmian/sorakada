import { COMMAND_IDS, type CommandId } from "./commandIds";

/**
 * A keybinding profile: command IDs mapped to platform-native accelerators.
 *
 * The profile is data, not behaviour, so a later Windows/custom profile can
 * replace these bindings without changing any command handler.
 */
export type KeymapProfile = Readonly<Partial<Record<CommandId, string>>>;

/**
 * The IDEA-style profile for this milestone.
 *
 * `Ctrl+W` closes the current Tab rather than the window, and `app.exit`
 * intentionally has no accelerator: Exit is reachable from the File menu and
 * the window close control only.
 */
export const IDEA_M1_KEYMAP: KeymapProfile = Object.freeze({
  "file.new": "Ctrl+N",
  "file.open": "Ctrl+O",
  "file.save": "Ctrl+S",
  "file.saveAs": "Ctrl+Shift+S",
  "file.close": "Ctrl+W",
  "editor.undo": "Ctrl+Z",
  "editor.redo": "Ctrl+Shift+Z",
});

/** The accelerator this profile assigns to `id`, if any. */
export function acceleratorFor(id: CommandId): string | undefined {
  return IDEA_M1_KEYMAP[id];
}

/** The part of a keyboard event this profile needs to match against. */
export interface AcceleratorEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Resolves a keyboard event to the command the IDEA profile binds to it.
 *
 * Returns `undefined` for anything that is not one of the profile's exact
 * combinations, so ordinary typing is never intercepted. The mapping is derived
 * from `IDEA_M1_KEYMAP` rather than duplicated, so the displayed menu
 * accelerator and the dispatched shortcut cannot drift apart.
 */
export function commandForKeyboardEvent(
  event: AcceleratorEvent,
): CommandId | undefined {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) {
    return undefined;
  }

  // `event.key` is already shifted ("Z" for Ctrl+Shift+Z), so only its case
  // needs normalising to match the profile's spelling.
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const pressed = `Ctrl+${event.shiftKey ? "Shift+" : ""}${key}`;

  for (const id of COMMAND_IDS) {
    if (IDEA_M1_KEYMAP[id] === pressed) {
      return id;
    }
  }

  return undefined;
}
