/**
 * The Explorer's context menu.
 *
 * It is intentionally small and fixed: 003 requires a working menu, not a
 * pluggable menu framework (FR-081). Which items appear is decided entirely by
 * the shared `FileOperationContext`, so the menu cannot offer an action the
 * command registry would refuse (FR-078, FR-080).
 *
 * The creation group is the one deliberate exception. It asks the
 * context-menu-specific predicate, because 004 hides New File/New Folder in a
 * file's menu while the shared commands and their selected-file parent target
 * stay exactly as 003 defined them (FR-006, FR-010).
 */

import { useEffect, useRef } from "react";

import { AppIcon, type AppIconName } from "../shell/AppIcon";
import {
  isContextMenuCreateAvailable,
  isContextMenuRefreshAvailable,
  isDeleteAvailable,
  isRenameAvailable,
  type FileOperationContext,
} from "./explorerActions";
import type { MenuPosition } from "./ExplorerTree";

/** The actions the menu can dispatch, all through shared command ids. */
export type ExplorerMenuAction =
  | "explorer.newFile"
  | "explorer.newFolder"
  | "explorer.rename"
  | "explorer.delete"
  | "explorer.refresh";

export interface ExplorerContextMenuProps {
  /** Viewport position the menu was requested at. */
  position: MenuPosition;
  /** The context derived when the menu opened. */
  context: FileOperationContext;
  /** Dispatches the chosen command through the shared registry. */
  onAction(action: ExplorerMenuAction): void;
  /** Closes the menu without dispatching anything. */
  onClose(): void;
}

interface MenuItem {
  action: ExplorerMenuAction;
  label: string;
  icon: AppIconName;
}

/**
 * Renders the context menu.
 *
 * It closes on an outside pointer press and on Escape, which are the two
 * dismissals a desktop context menu is expected to support.
 */
export function ExplorerContextMenu({
  position,
  context,
  onAction,
  onClose,
}: ExplorerContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  const groups: MenuItem[][] = [];

  // Creation is offered for the root and directory contexts only: a file's menu
  // reads as file-local actions, even though the header still creates beside a
  // selected file through the shared target rule (FR-006, FR-007, SR-002).
  if (isContextMenuCreateAvailable(context)) {
    groups.push([
      { action: "explorer.newFile", label: "New File", icon: "new-file" },
      { action: "explorer.newFolder", label: "New Folder", icon: "new-folder" },
    ]);
  }

  const entryItems: MenuItem[] = [];
  if (isRenameAvailable(context)) {
    entryItems.push({ action: "explorer.rename", label: "Rename", icon: "rename" });
  }
  if (isDeleteAvailable(context)) {
    entryItems.push({ action: "explorer.delete", label: "Delete", icon: "delete" });
  }
  if (entryItems.length > 0) {
    groups.push(entryItems);
  }

  // Refresh belongs to the root and directory contexts; a file context offers
  // Rename and Delete only (plan decision 12, FR-006).
  if (isContextMenuRefreshAvailable(context)) {
    groups.push([
      { action: "explorer.refresh", label: "Refresh", icon: "refresh" },
    ]);
  }

  return (
    <div
      ref={menuRef}
      className="explorer-menu"
      role="menu"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      // The menu itself must not be treated as Explorer blank space.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {groups.map((group, index) => (
        <div className="explorer-menu__group" key={group[0].action}>
          {index > 0 ? <div className="explorer-menu__separator" role="separator" /> : null}
          {group.map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              className="explorer-menu__item"
              onClick={() => {
                onAction(item.action);
              }}
            >
              <AppIcon name={item.icon} className="explorer-menu__icon" />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
