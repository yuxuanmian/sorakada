import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Editor } from "../editor/Editor";
import { createEditorHandle } from "../editor/editorHandle";
import { nativeFileDialogService } from "../services/fileDialogs";
import { tauriFileService } from "../services/fileService";
import { createCommandRegistry } from "./commands/commandRegistry";
import type { CommandId } from "./commands/commandIds";
import { commandForKeyboardEvent } from "./commands/ideaKeymap";
import { DocumentController } from "./document/documentController";
import { installAppMenu } from "./menu/appMenu";
import { installWindowLifecycle } from "./window/windowLifecycle";

import "../styles/global.css";

/**
 * Whether the page is running inside the Tauri desktop shell.
 *
 * Native menus, dialogs and window control only exist there; a plain browser
 * `vite dev` session must still render the editor instead of failing on a
 * missing IPC bridge.
 */
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Application shell.
 *
 * React owns the UI and the session *metadata*; CodeMirror owns the live
 * document; Rust owns the byte-level file format. This component only wires
 * those three together and registers the command handlers.
 */
export function App() {
  const [editorHandle] = useState(createEditorHandle);
  const [registry] = useState(createCommandRegistry);
  const [controller] = useState(
    () =>
      new DocumentController({
        editor: editorHandle,
        fileService: tauriFileService,
        dialogs: nativeFileDialogService,
        destroyWindow: () => getCurrentWindow().destroy(),
      }),
  );

  useEffect(() => {
    editorHandle.setDocumentChangeListener(() => {
      controller.handleDocumentChanged();
    });

    // Commands carry no business logic of their own: they only forward to the
    // controller or the editor, which keeps menu, accelerator and (later)
    // custom keybinding surfaces equivalent by construction.
    const unregisterHandlers = [
      registry.register("file.new", async () => {
        await controller.newDocument();
      }),
      registry.register("file.open", async () => {
        await controller.openDocument();
      }),
      registry.register("file.save", async () => {
        await controller.save();
      }),
      registry.register("file.saveAs", async () => {
        await controller.saveAs();
      }),
      registry.register("app.exit", async () => {
        await controller.exit();
      }),
      registry.register("editor.undo", () => {
        editorHandle.undo();
      }),
      registry.register("editor.redo", () => {
        editorHandle.redo();
      }),
    ];

    /**
     * The application shortcut dispatcher — the single route for the IDEA
     * profile.
     *
     * This lives here rather than on the native menu items because Tauri's menu
     * accelerators are not translated into menu commands while the WebView2 has
     * focus: the keystroke is delivered to the page instead, so a native
     * accelerator would silently do nothing. The menu therefore only *displays*
     * the shortcuts, and this handler performs them.
     *
     * The mapping comes from the same `IDEA_M1_KEYMAP` data the menu renders, so
     * the advertised shortcut and the dispatched command cannot drift apart, and
     * each keypress resolves to at most one command (FR-032).
     *
     * `stopPropagation` keeps CodeMirror's own `Mod-z` history binding from
     * undoing a second time for the same keypress.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      const commandId = commandForKeyboardEvent(event);
      if (commandId === undefined) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void registry.execute(commandId).catch((error: unknown) => {
        void nativeFileDialogService.showError(describeError(error));
      });
    };

    window.addEventListener("keydown", onKeyDown, true);

    let disposed = false;
    let disposeMenu: (() => Promise<void>) | null = null;
    let disposeWindow: (() => void) | null = null;

    const installNativeSurfaces = async (): Promise<void> => {
      if (!isTauriRuntime()) {
        return;
      }

      const appWindow = getCurrentWindow();
      const stopWindowLifecycle = await installWindowLifecycle(
        controller,
        appWindow,
      );
      const restoreMenu = await installAppMenu({
        executeCommand: (id: CommandId) => registry.execute(id),
        onCommandError: (error: unknown) => {
          void nativeFileDialogService.showError(describeError(error));
        },
      });

      // React Strict Mode mounts, unmounts and mounts again; an installation
      // that lost the race has to clean itself up rather than leak a menu or a
      // duplicate close listener.
      if (disposed) {
        stopWindowLifecycle();
        await restoreMenu();
        return;
      }

      disposeWindow = stopWindowLifecycle;
      disposeMenu = restoreMenu;
    };

    void installNativeSurfaces();

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown, true);
      editorHandle.setDocumentChangeListener(null);

      for (const unregister of unregisterHandlers) {
        unregister();
      }

      disposeWindow?.();
      void disposeMenu?.();
    };
  }, [controller, editorHandle, registry]);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__wordmark">Sorakada</span>
      </header>

      <main className="app__content">
        <Editor handle={editorHandle} />
      </main>
    </div>
  );
}
