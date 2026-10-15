/**
 * The one place a menu activation becomes a command (007 T075, FR-096).
 *
 * Both the compact App Menu and the Explorer context menu route an activated
 * item through this helper, so "one activation executes at most one command" is
 * a property of a single function rather than of each surface's callback. An item
 * without a command id (a purely local entry) activates nothing.
 */

import type { CommandId } from "../commands/commandIds";
import type { SoraMenuItem } from "../../ui/menu/menuModel";

/**
 * Dispatches the command an activated item stands for.
 *
 * Returns the command id that was dispatched, or `undefined` when the item names
 * no command — which also makes the "exactly once" behaviour directly assertable.
 */
export function activateMenuItem(
  item: SoraMenuItem,
  onCommand: (id: CommandId) => void,
): CommandId | undefined {
  if (item.commandId === undefined) {
    return undefined;
  }
  onCommand(item.commandId);
  return item.commandId;
}
