/**
 * The Explorer's context menu (007 T066, T069).
 *
 * 004/003 semantics are preserved on purpose while the *surface* changes:
 *
 * - the menu still offers creation for root/directory contexts, Rename/Delete for
 *   an entry and Refresh for root/directory contexts, all through the same
 *   `ExplorerMenuAction` command ids as before (T066, T067);
 * - the operation context is still captured at the moment of the gesture, and a
 *   right click still selects the logical row first (T068);
 * - there is still exactly **one** controlled menu surface for the whole Tree.
 *   The trigger covers the Tree body and reports the pointer target, so no
 *   recyclable row ever owns authoritative popup state (T069).
 *
 * Keyboard navigation, focus handling, outside-press dismissal and portal
 * placement now come from the Sorakada `SoraContextMenu` wrapper instead of the
 * hand-written outside-click/z-index code 003 had (T070..T072).
 */

import type { ReactNode } from "react";

import type { CommandId } from "../commands/commandIds";
import { IconGlyph } from "../shell/AppIcon";
import { uiIcon } from "../icons/uiIconProvider";
import type { UiIconId } from "../icons/iconTypes";
import { SoraContextMenu, type SoraContextTarget } from "../../ui/context-menu/SoraContextMenu";
import type { SoraMenuItem } from "../../ui/menu/menuModel";
import { activateMenuItem } from "../menu/menuActivation";
import type { FileOperationContext } from "./explorerActions";
import {
  buildExplorerMenuModel,
  type ExplorerMenuAction,
} from "./explorerMenuModel";

export type { ExplorerMenuAction };

/** The glyph each context action displays. */
const ACTION_ICONS: Readonly<Record<ExplorerMenuAction, UiIconId>> = {
  "explorer.newFile": "new-file",
  "explorer.newFolder": "new-folder",
  "explorer.rename": "rename",
  "explorer.delete": "delete",
  "explorer.refresh": "refresh",
};

function isExplorerMenuAction(value: string): value is ExplorerMenuAction {
  return value in ACTION_ICONS;
}

export interface ExplorerContextMenuProps {
  /** The region that opens the menu: the Tree body, blank space included. */
  children: ReactNode;
  /**
   * The operation context currently targeted, or `null` when no gesture has
   * targeted anything yet.
   */
  context: FileOperationContext | null;
  /** Reports the gesture target so the caller can capture the logical row. */
  onTarget(target: SoraContextTarget): void;
  /** Dispatches the chosen command through the shared registry. */
  onAction(action: ExplorerMenuAction): void;
  /** Reports open/closed transitions, so a closed menu drops its target. */
  onOpenChange?(open: boolean): void;
  /** Whether a command is currently available in the shared registry. */
  isEnabled(commandId: CommandId): boolean;
  /**
   * Whether the popup is suppressed while gestures are still reported (T229).
   *
   * The development-only Tree fixture has no filesystem operations to offer: it
   * keeps the right-click *target* inside its own UI state but must not present a
   * menu whose every item would act on the real Workspace behind it.
   */
  suppressPopup?: boolean;
}

/** Renders the Explorer's single controlled context menu over its trigger. */
export function ExplorerContextMenu({
  children,
  context,
  onTarget,
  onAction,
  onOpenChange,
  isEnabled,
  suppressPopup = false,
}: ExplorerContextMenuProps) {
  const model =
    context === null ? [] : buildExplorerMenuModel(context, { isEnabled });

  // Icons are presentation, so they are attached here rather than in the pure
  // model: the grouping/target rules stay testable without React.
  const withIcons = model.map((section) => ({
    ...section,
    items: section.items.map((entry) => ({
      ...entry,
      icon: isExplorerMenuAction(entry.id) ? (
        <IconGlyph descriptor={uiIcon(ACTION_ICONS[entry.id])} />
      ) : undefined,
    })),
  }));

  return (
    <SoraContextMenu
      // The trigger is a `display: contents` region (`ui.css`), so the Tree's own
      // scroll viewport stays a direct flex child of the Explorer region rather
      // than being wrapped in an extra box (T099).
      model={withIcons}
      ariaLabel="Explorer actions"
      // Controlled closed while suppressed, so an empty popup is never shown and
      // the gesture target is still reported (T229).
      open={suppressPopup ? false : undefined}
      onTarget={onTarget}
      onOpenChange={onOpenChange}
      onAction={(entry: SoraMenuItem) => {
        const dispatched = activateMenuItem(entry, (id) => {
          if (isExplorerMenuAction(id)) {
            onAction(id);
          }
        });
        if (dispatched === undefined) {
          return;
        }
      }}
    >
      {children}
    </SoraContextMenu>
  );
}
