import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Editor } from "../editor/Editor";
import { createEditorHandle } from "../editor/editorHandle";
import { nativeFileDialogService } from "../services/fileDialogs";
import { tauriFileService } from "../services/fileService";
import { createCommandRegistry } from "./commands/commandRegistry";
import type { CommandId } from "./commands/commandIds";
import { commandForKeyboardEvent } from "./commands/ideaKeymap";
import { DocumentManager } from "./document/documentManager";
import type { DocumentManagerSnapshot } from "./document/documentSession";
import { processDroppedPaths } from "./dragdrop/fileDropController";
import { installAppMenu } from "./menu/appMenu";
import {
  createActivationBenchmark,
  installActivationBenchmark,
} from "./performance/activationBenchmark";
import { TabBar } from "./tabs/TabBar";
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
 * React owns the UI and the lightweight Tab *metadata*; the `DocumentManager`
 * owns the documents; CodeMirror owns the live text; Rust owns the byte-level
 * file format. This component only wires those together and registers the
 * command handlers.
 */
export function App() {
  const [editorHandle] = useState(createEditorHandle);
  const [registry] = useState(createCommandRegistry);
  const [benchmark] = useState(createActivationBenchmark);
  const [manager] = useState(
    () =>
      new DocumentManager({
        editor: editorHandle,
        fileService: tauriFileService,
        dialogs: nativeFileDialogService,
        activationBenchmark: benchmark,
      }),
  );
  const [snapshot, setSnapshot] = useState<DocumentManagerSnapshot>(() =>
    manager.getSnapshot(),
  );

  // Purely visual: the manager owns what a drop actually does.
  const [isFileDragActive, setIsFileDragActive] = useState(false);

  // The document the shared view starts on. Captured once: every later switch
  // goes through the manager, never through a new `EditorView`.
  const [initialDocument] = useState(() => {
    const session = manager.getActiveSession();
    return { documentId: session.id, initialState: session.editorState };
  });

  useEffect(() => {
    const unsubscribe = manager.subscribe(setSnapshot);

    // Benchmark-only: publishes the SC-005 timing marks for the manual
    // switching run described in `quickstart.md` §12.
    installActivationBenchmark(benchmark);

    // The bridge reports every state update with the document it was bound to,
    // which is what keeps a Tab switch from being credited to the wrong Tab.
    editorHandle.setStateUpdateListener((documentId, state, docChanged) => {
      manager.handleEditorStateUpdate(documentId, state, docChanged);
    });

    // Commands carry no business logic of their own: they only forward to the
    // manager or the editor, which keeps menu, accelerator and (later) custom
    // keybinding surfaces equivalent by construction.
    const unregisterHandlers = [
      registry.register("file.new", () => {
        manager.createUntitled();
      }),
      registry.register("file.open", async () => {
        await manager.openFromDialog();
      }),
      registry.register("file.save", async () => {
        await manager.saveDocument(manager.getActiveSession().id);
      }),
      registry.register("file.saveAs", async () => {
        await manager.saveDocumentAs(manager.getActiveSession().id);
      }),
      registry.register("file.close", async () => {
        await manager.closeDocument(manager.getActiveSession().id);
      }),
      registry.register("app.exit", async () => {
        // Exit asks the manager once, then destroys directly: the normal
        // last-Tab replacement rule must not run during application exit.
        if (await manager.prepareCloseAll()) {
          await getCurrentWindow().destroy();
        }
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
     * each keypress resolves to at most one command.
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
    let disposeDragDrop: (() => void) | null = null;

    const installNativeSurfaces = async (): Promise<void> => {
      if (!isTauriRuntime()) {
        return;
      }

      const appWindow = getCurrentWindow();
      const stopWindowLifecycle = await installWindowLifecycle(
        manager,
        appWindow,
      );

      // Native drag/drop only exists in the desktop shell; a browser-only
      // session must not attempt to install it at all.
      const unlistenDragDrop = await appWindow.onDragDropEvent((event) => {
        const payload = event.payload;

        if (payload.type === "enter" || payload.type === "over") {
          setIsFileDragActive(true);
          return;
        }
        if (payload.type === "leave") {
          setIsFileDragActive(false);
          return;
        }

        setIsFileDragActive(false);
        // The batch drives the same open pipeline as File > Open and reports
        // its own failures, so nothing here needs to surface an error.
        void processDroppedPaths(payload.paths, manager);
      });

      const restoreMenu = await installAppMenu({
        executeCommand: (id: CommandId) => registry.execute(id),
        onCommandError: (error: unknown) => {
          void nativeFileDialogService.showError(describeError(error));
        },
      });

      // React Strict Mode mounts, unmounts and mounts again; an installation
      // that lost the race has to clean itself up rather than leak a menu, a
      // close listener or a drag/drop listener.
      if (disposed) {
        stopWindowLifecycle();
        unlistenDragDrop();
        await restoreMenu();
        return;
      }

      disposeWindow = stopWindowLifecycle;
      disposeDragDrop = unlistenDragDrop;
      disposeMenu = restoreMenu;
    };

    void installNativeSurfaces();

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown, true);
      editorHandle.setStateUpdateListener(null);
      unsubscribe();

      for (const unregister of unregisterHandlers) {
        unregister();
      }

      disposeDragDrop?.();
      disposeWindow?.();
      void disposeMenu?.();
    };
  }, [benchmark, editorHandle, manager, registry]);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__wordmark">Sorakada</span>
      </header>

      <main className="app__content">
        <TabBar
          tabs={snapshot.tabs}
          onSelect={(id) => {
            manager.selectDocument(id);
          }}
          onClose={(id) => {
            void manager.closeDocument(id);
          }}
        />

        <div className="editor-area">
          <Editor
            handle={editorHandle}
            documentId={initialDocument.documentId}
            initialState={initialDocument.initialState}
          />
          {isFileDragActive ? (
            <div className="drop-overlay" aria-hidden="true" />
          ) : null}
        </div>
      </main>
    </div>
  );
}
