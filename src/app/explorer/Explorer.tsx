/**
 * The Explorer container.
 *
 * It owns no filesystem or document state: it renders the controller's state,
 * resolves every action through the shared command registry, and scopes the
 * plain `F2`/`Delete` keys to itself.
 */

import { useEffect, useState, type KeyboardEvent } from "react";

import type { CommandId } from "../commands/commandIds";
import { AppIcon, type AppIconName } from "../shell/AppIcon";
import type { ExplorerActions } from "./explorerActions";
import type { ExplorerController } from "./explorerController";
import type { ExplorerNode, ExplorerState } from "./explorerModel";
import { ExplorerContextMenu, type ExplorerMenuAction } from "./ExplorerContextMenu";
import { ExplorerTree, type MenuPosition } from "./ExplorerTree";

import "../../styles/explorer.css";

export interface ExplorerProps {
  /** The controller's current projection. */
  state: ExplorerState;
  /** The controller that owns selection, expansion and the inline editor. */
  controller: ExplorerController;
  /** Display name of the active Workspace, or `null` when none is open. */
  workspaceName: string | null;
  /** Operation targeting and filesystem orchestration. */
  actions: ExplorerActions;
  /** Opens a folder as the Workspace (the no-Workspace entry point). */
  onOpenFolder(): void;
  /** Dispatches a command through the shared registry. */
  onCommand(id: CommandId): void;
}

/**
 * Renders the Explorer for the active Workspace, or the no-Workspace entry
 * point.
 */
export function Explorer({
  state,
  controller,
  workspaceName,
  actions,
  onOpenFolder,
  onCommand,
}: ExplorerProps) {
  const [menu, setMenu] = useState<{
    position: MenuPosition;
    context: ReturnType<ExplorerActions["handleContextMenu"]>;
  } | null>(null);

  // A WorkContext replacement invalidates any open menu and its captured target.
  useEffect(() => {
    setMenu(null);
  }, [state.contextId]);

  if (state.contextId === null) {
    // Without a Workspace the Explorer offers no filesystem mutation context
    // menu at all; its only action is opening a folder (FR-053, US8 acceptance 5).
    return (
      <div className="explorer explorer--empty">
        <p className="explorer__hint">No folder is open.</p>
        <button type="button" className="shell-button" onClick={onOpenFolder}>
          Open Folder
        </button>
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Explorer-local triggers: F2/Delete are deliberately absent from the global
    // keymap, so pressing Delete while the editor has focus still deletes text.
    // Whether the command is *available* is left to the registry, which is the
    // single availability authority (FR-079, FR-080).
    if (event.key === "F2") {
      event.preventDefault();
      onCommand("explorer.rename");
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      onCommand("explorer.delete");
    }
  };

  const headerButton = (
    id: CommandId,
    label: string,
    icon: AppIconName,
    enabled: boolean,
  ) => (
    <button
      type="button"
      className="explorer__action"
      title={label}
      aria-label={label}
      disabled={!enabled}
      onClick={() => {
        onCommand(id);
      }}
    >
      <AppIcon name={icon} />
    </button>
  );

  const openMenu = (node: ExplorerNode | null, position: MenuPosition): void => {
    // Right-click selects the target first, so the menu and the command registry
    // resolve the same operation context (FR-076, FR-080).
    setMenu({ position, context: actions.handleContextMenu(node) });
  };

  return (
    <div
      className="explorer"
      tabIndex={0}
      role="group"
      aria-label="Explorer"
      onKeyDown={onKeyDown}
    >
      <div className="explorer__header">
        <span className="explorer__title" title={workspaceName ?? undefined}>
          {workspaceName ?? "Workspace"}
        </span>
        <div className="explorer__actions">
          {headerButton(
            "explorer.newFile",
            "New File",
            "new-file",
            actions.isCreateAvailable(),
          )}
          {headerButton(
            "explorer.newFolder",
            "New Folder",
            "new-folder",
            actions.isCreateAvailable(),
          )}
          {headerButton(
            "explorer.refresh",
            "Refresh",
            "refresh",
            actions.isRefreshAvailable(),
          )}
        </div>
      </div>

      {state.rootUnavailable ? (
        <p className="explorer__error" role="alert">
          This folder could not be read. Use Refresh to try again.
        </p>
      ) : null}

      <div
        className="explorer__body"
        onContextMenu={(event) => {
          // Every row stops propagation before bubbling here, so anything that
          // reaches the body is genuinely blank space — including the area below
          // the last rendered row, which is inside this scrollable element and
          // not inside the tree itself. Blank space is always the Workspace-root
          // context and never a stale previous node target (FR-077).
          event.preventDefault();
          openMenu(null, { x: event.clientX, y: event.clientY });
        }}
      >
        <ExplorerTree
          state={state}
          onSelect={(path) => {
            controller.selectPath(path);
          }}
          onToggleDirectory={(path) => {
            void controller.toggleDirectory(path);
          }}
          onOpenFile={(path) => {
            void actions.openFile(path);
          }}
          onContextMenu={openMenu}
          onInlineDraftChange={(name) => {
            controller.updateInlineDraft(name);
          }}
          onInlineCommit={() => {
            void actions.commitInlineEdit();
          }}
          onInlineCancel={() => {
            controller.cancelInlineEdit();
          }}
        />
      </div>

      {menu === null ? null : (
        <ExplorerContextMenu
          position={menu.position}
          context={menu.context}
          onAction={(action: ExplorerMenuAction) => {
            setMenu(null);
            onCommand(action);
          }}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}
