import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";

import { acceleratorFor } from "../commands/ideaKeymap";
import type { CommandId } from "../commands/commandIds";

export interface AppMenuDeps {
  /** Dispatches a command through the shared registry. */
  executeCommand(id: CommandId): Promise<void>;
  /** Reports a failure that escaped a command handler. */
  onCommandError?(error: unknown): void;
}

/**
 * Builds and installs the native File/Edit menu.
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
 * IDEA profile data and executes it through this same registry. Returns the
 * function that restores the previous application menu.
 */
export async function installAppMenu(
  deps: AppMenuDeps,
): Promise<() => Promise<void>> {
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

  const commandItem = (id: CommandId, label: string): Promise<MenuItem> => {
    const accelerator = acceleratorFor(id);
    return MenuItem.new({
      id,
      // Win32 menus render whatever follows a tab as right-aligned accelerator
      // text, which keeps the profile visible without binding it.
      text: accelerator === undefined ? label : `${label}\t${accelerator}`,
      action: () => {
        dispatch(id);
      },
    });
  };

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await commandItem("file.new", "New"),
      await commandItem("file.open", "Open..."),
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

  const menu = await Menu.new({ items: [fileMenu, editMenu] });
  const previousMenu = await menu.setAsAppMenu();

  return async () => {
    if (previousMenu !== null) {
      await previousMenu.setAsAppMenu();
    }
  };
}
