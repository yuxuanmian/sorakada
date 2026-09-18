import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";

import { acceleratorFor } from "../commands/ideaKeymap";
import type { CommandId } from "../commands/commandIds";

export interface AppMenuDeps {
  /** Dispatches a command through the shared registry. */
  executeCommand(id: CommandId): Promise<void>;
  /** Reports a failure that escaped a command handler. */
  onCommandError?(error: unknown): void;
  /**
   * The shared availability decision for a command.
   *
   * The menu asks the same registry every other surface asks, so a native menu
   * item can never be enabled for a command the registry would refuse (FR-019,
   * FR-020).
   */
  isCommandEnabled(id: CommandId): boolean;
}

/** A live installation of the application menu. */
export interface AppMenuInstallation {
  /**
   * Pushes the current availability of every command item to the native menu.
   *
   * The application calls this whenever document, Workspace or Explorer
   * operation state changes.
   */
  syncAvailability(): Promise<void>;
  /** Restores the previous application menu. */
  restore(): Promise<void>;
}

/**
 * Builds and installs the native File/Edit/View menu.
 *
 * Every menu click dispatches a stable command ID through the registry, so a
 * menu click and a keyboard shortcut reach exactly the same handler.
 *
 * The shortcut is displayed in the menu's accelerator column, but it is
 * deliberately *not* registered as a native menu accelerator. Tauri's menu
 * accelerators are not translated into menu commands while the WebView2 holds
 * focus — the keystroke is delivered to the page instead — so registering them
 * would advertise shortcuts that never fire. The single working dispatcher is
 * the application-level `keydown` handler in `App.tsx`, which resolves the same
 * IDEA profile data and executes it through this same registry.
 */
export async function installAppMenu(
  deps: AppMenuDeps,
): Promise<AppMenuInstallation> {
  const dispatch = (id: CommandId): void => {
    // Menu actions are synchronous callbacks, so the asynchronous command runs
    // detached — but never unobserved.
    void deps.executeCommand(id).catch((error: unknown) => {
      if (deps.onCommandError) {
        deps.onCommandError(error);
        return;
      }
      console.error(`Command "${id}" failed.`, error);
    });
  };

  /** Every command item, so availability can be re-applied after any change. */
  const commandItems = new Map<CommandId, MenuItem>();

  const commandItem = async (id: CommandId, label: string): Promise<MenuItem> => {
    const accelerator = acceleratorFor(id);
    const item = await MenuItem.new({
      id,
      // Win32 menus render whatever follows a tab as right-aligned accelerator
      // text, which keeps the profile visible without binding it.
      text: accelerator === undefined ? label : `${label}\t${accelerator}`,
      action: () => {
        dispatch(id);
      },
    });
    commandItems.set(id, item);
    return item;
  };

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await commandItem("file.new", "New"),
      await commandItem("file.open", "Open..."),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await commandItem("workspace.openFolder", "Open Folder..."),
      await commandItem("workspace.closeFolder", "Close Folder"),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await commandItem("file.save", "Save"),
      await commandItem("file.saveAs", "Save As..."),
      await commandItem("file.close", "Close"),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await commandItem("app.exit", "Exit"),
    ],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await commandItem("editor.undo", "Undo"),
      await commandItem("editor.redo", "Redo"),
    ],
  });

  const viewMenu = await Submenu.new({
    text: "View",
    items: [await commandItem("view.toggleExplorer", "Explorer")],
  });

  const menu = await Menu.new({ items: [fileMenu, editMenu, viewMenu] });
  const previousMenu = await menu.setAsAppMenu();

  const syncAvailability = async (): Promise<void> => {
    for (const [id, item] of commandItems) {
      await item.setEnabled(deps.isCommandEnabled(id));
    }
  };

  // The menu must never appear with stale enabled state on a launch where the
  // registry was already populated.
  await syncAvailability();

  return {
    syncAvailability,
    restore: async () => {
      commandItems.clear();
      if (previousMenu !== null) {
        await previousMenu.setAsAppMenu();
      }
    },
  };
}
