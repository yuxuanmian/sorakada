/**
 * The Explorer context-menu model (007 T066, T067, FR-016, FR-030).
 *
 * Which entries a context menu offers is decided entirely by the shared
 * `FileOperationContext`, exactly as 003/004 defined it — including the one
 * deliberate 004 exception that a *file's* menu omits New File/New Folder while
 * root and directory contexts keep them. Nothing here redefines operation
 * context, and nothing here executes anything: the model only names command ids.
 *
 * Kept free of React and of the headless primitive so the grouping rule is
 * provable without a DOM.
 */

import type { CommandId } from "../commands/commandIds";
import type { AppTranslator, TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import type { SoraMenuItem, SoraMenuModel, SoraMenuSection } from "../../ui/menu/menuModel";
import {
  isContextMenuCreateAvailable,
  isContextMenuRefreshAvailable,
  isDeleteAvailable,
  isRenameAvailable,
  type FileOperationContext,
} from "./explorerActions";

/** The actions the Explorer's context menu can dispatch. */
export type ExplorerMenuAction =
  | "explorer.newFile"
  | "explorer.newFolder"
  | "explorer.rename"
  | "explorer.delete"
  | "explorer.refresh";

export interface ExplorerMenuModelOptions {
  /**
   * The shared availability decision.
   *
   * It is the registry's, so a context menu can never offer an action the
   * command layer would refuse (FR-022, FR-030).
   */
  isEnabled(commandId: CommandId): boolean;
  t?: AppTranslator;
}

/** The translation key each action displays. */
const ACTION_LABEL_KEYS: Readonly<Record<ExplorerMenuAction, TranslationKey>> = {
  "explorer.newFile": "ui.explorer.contextMenu.newFile",
  "explorer.newFolder": "ui.explorer.contextMenu.newFolder",
  "explorer.rename": "ui.explorer.contextMenu.rename",
  "explorer.delete": "ui.explorer.contextMenu.delete",
  "explorer.refresh": "ui.explorer.contextMenu.refresh",
};

function item(
  action: ExplorerMenuAction,
  isEnabled: (commandId: CommandId) => boolean,
  translate: AppTranslator,
): SoraMenuItem {
  return {
    id: action,
    label: translate(ACTION_LABEL_KEYS[action]),
    commandId: action,
    ...(isEnabled(action) ? {} : { disabled: true }),
  };
}

/**
 * Builds the context menu for one captured operation context.
 *
 * Sections are separated by a divider and an empty section disappears entirely,
 * which is what preserves the 003/004 rule that a file's menu offers file-local
 * actions only.
 */
export function buildExplorerMenuModel(
  context: FileOperationContext,
  options: ExplorerMenuModelOptions,
): SoraMenuModel {
  const { isEnabled, t: translate = t } = options;
  const sections: SoraMenuSection[] = [];

  // Creation is offered for the root and directory contexts only: a file's menu
  // reads as file-local actions, even though the shared commands still create
  // beside a selected file through the 003 target rule (FR-006, FR-007, SR-002).
  if (isContextMenuCreateAvailable(context)) {
    sections.push({
      id: "create",
      items: [
        item("explorer.newFile", isEnabled, translate),
        item("explorer.newFolder", isEnabled, translate),
      ],
    });
  }

  const entryItems: SoraMenuItem[] = [];
  if (isRenameAvailable(context)) {
    entryItems.push(item("explorer.rename", isEnabled, translate));
  }
  if (isDeleteAvailable(context)) {
    entryItems.push(item("explorer.delete", isEnabled, translate));
  }
  if (entryItems.length > 0) {
    sections.push({ id: "entry", items: entryItems });
  }

  // Refresh belongs to the root and directory contexts; a file context offers
  // Rename and Delete only (plan decision 12, FR-006, SR-002).
  if (isContextMenuRefreshAvailable(context)) {
    sections.push({
      id: "refresh",
      items: [item("explorer.refresh", isEnabled, translate)],
    });
  }

  return sections;
}

/** Every action the model can name, in display order. */
export const EXPLORER_MENU_ACTIONS: readonly ExplorerMenuAction[] = [
  "explorer.newFile",
  "explorer.newFolder",
  "explorer.rename",
  "explorer.delete",
  "explorer.refresh",
];
