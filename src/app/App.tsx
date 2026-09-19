import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Editor } from "../editor/Editor";
import { createEditorHandle } from "../editor/editorHandle";
import { nativeFileDialogService } from "../services/fileDialogs";
import { tauriFileService } from "../services/fileService";
import { tauriFilesystemWatcher } from "../services/filesystemWatcher";
import { nativeWorkspaceDialogService } from "../services/workspaceDialogs";
import { tauriWorkspaceFileService } from "../services/workspaceFileService";
import { createCommandRegistry } from "./commands/commandRegistry";
import type { CommandId } from "./commands/commandIds";
import { commandForKeyboardEvent } from "./commands/ideaKeymap";
import { DiskValidator } from "./document/diskValidation";
import { DocumentManager } from "./document/documentManager";
import type { DocumentManagerSnapshot } from "./document/documentSession";
import { InternalFsOperationGuard } from "./document/internalFsOperationGuard";
import { OpenedDocumentWatchCoordinator } from "./document/openedDocumentWatchCoordinator";
import { processDroppedPaths } from "./dragdrop/fileDropController";
import { Explorer } from "./explorer/Explorer";
import { ExplorerActions } from "./explorer/explorerActions";
import { ExplorerController } from "./explorer/explorerController";
import {
  createEmptyExplorerState,
  type ExplorerState,
} from "./explorer/explorerModel";
import { installAppMenu, type AppMenuInstallation } from "./menu/appMenu";
import {
  createActivationBenchmark,
  installActivationBenchmark,
} from "./performance/activationBenchmark";
import {
  AppShell,
  DEFAULT_UI_LAYOUT,
  clampSidebarWidth,
  type UiLayoutState,
} from "./shell/AppShell";
import { EmptyState } from "./shell/EmptyState";
import { TabBar } from "./tabs/TabBar";
import { installWindowLifecycle } from "./window/windowLifecycle";
import { WorkContextManager } from "./workspace/workContextManager";

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
 * The application has two independent axes: zero or one active Workspace, and
 * zero or more open documents. React owns the UI and the lightweight metadata;
 * `DocumentManager` owns documents, `WorkContextManager` owns the Workspace
 * identity, `ExplorerController` owns the transient Tree state, CodeMirror owns
 * the live text, and Rust owns the filesystem. This component only wires those
 * together and registers command handlers.
 */
export function App() {
  const [editorHandle] = useState(createEditorHandle);
  const [registry] = useState(createCommandRegistry);
  const [benchmark] = useState(createActivationBenchmark);
  /**
   * 005 shares one validation and one internal-operation guard between the
   * manager (which writes the filesystem) and the watcher consumer (which reads
   * the hints those writes produce), so "our own event" has exactly one
   * definition (FR-035).
   */
  const [internalFsOperations] = useState(() => new InternalFsOperationGuard());
  const [diskValidator] = useState(
    () => new DiskValidator({ fileService: tauriFileService }),
  );
  const [manager] = useState(
    () =>
      new DocumentManager({
        editor: editorHandle,
        fileService: tauriFileService,
        dialogs: nativeFileDialogService,
        activationBenchmark: benchmark,
        diskValidator,
        internalFsOperations,
      }),
  );
  const [watcher] = useState(
    () =>
      new OpenedDocumentWatchCoordinator({
        documents: manager,
        validator: diskValidator,
        watcher: tauriFilesystemWatcher,
        guard: internalFsOperations,
      }),
  );
  const [workContext] = useState(
    () =>
      new WorkContextManager({
        workspaceFileService: tauriWorkspaceFileService,
        dialogs: nativeWorkspaceDialogService,
      }),
  );
  const [controller] = useState(
    () =>
      new ExplorerController({
        workspaceFileService: tauriWorkspaceFileService,
        // The Explorer detects an unreadable root; the WorkContext keeps the
        // active Workspace and exposes the unavailable state (FR-088).
        onRootUnavailable: (unavailable) => {
          workContext.setRootUnavailable(unavailable);
        },
      }),
  );
  const [actions] = useState(
    () =>
      new ExplorerActions({
        explorer: controller,
        workContexts: workContext,
        workspaceFileService: tauriWorkspaceFileService,
        documents: manager,
        dialogs: nativeWorkspaceDialogService,
        fileService: tauriFileService,
      }),
  );

  const [snapshot, setSnapshot] = useState<DocumentManagerSnapshot>(() =>
    manager.getSnapshot(),
  );
  const [explorerState, setExplorerState] = useState<ExplorerState>(
    createEmptyExplorerState,
  );
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [layout, setLayout] = useState<UiLayoutState>(DEFAULT_UI_LAYOUT);

  // Purely visual: the manager owns what a drop actually does.
  const [isFileDragActive, setIsFileDragActive] = useState(false);

  /** The live native-menu installation, so availability can be re-synced. */
  const menuRef = useRef<AppMenuInstallation | null>(null);

  /** Runs a command and reports anything that escapes its handler. */
  const dispatch = useCallback(
    (id: CommandId): void => {
      void registry.execute(id).catch((error: unknown) => {
        void nativeFileDialogService.showError(describeError(error));
      });
    },
    [registry],
  );

  useEffect(() => {
    const unsubscribeDocuments = manager.subscribe(setSnapshot);
    const unsubscribeExplorer = controller.subscribe(setExplorerState);
    const unsubscribeWorkspace = workContext.subscribe((workspace) => {
      setWorkspaceName(workspace.context?.displayName ?? null);
    });

    // Benchmark-only: publishes the SC-005 timing marks for the manual
    // switching run described in `quickstart.md` §12.
    installActivationBenchmark(benchmark);

    // 005: the opened-document watcher consumer. It only listens here — every
    // validation it starts is asynchronous, so nothing on this path can block a
    // keystroke or the first paint.
    void watcher.start();

    // The bridge reports every state update with the document it was bound to,
    // which is what keeps a Tab switch from being credited to the wrong Tab.
    editorHandle.setStateUpdateListener((documentId, state, docChanged) => {
      manager.handleEditorStateUpdate(documentId, state, docChanged);
    });

    const hasActiveDocument = (): boolean =>
      manager.getActiveDocumentId() !== null;

    // Commands carry no business logic of their own: they only forward to the
    // manager, the Workspace or the Explorer actions, which keeps menu,
    // accelerator, context-menu and keyboard surfaces equivalent by
    // construction. Availability is declared once, here, and every surface
    // reads it from the same registry.
    const unregisterHandlers = [
      registry.register("file.new", {
        execute: () => {
          manager.createUntitled();
        },
      }),
      registry.register("file.open", {
        execute: async () => {
          await manager.openFromDialog();
        },
      }),
      registry.register("file.save", {
        execute: async () => {
          const id = manager.getActiveDocumentId();
          if (id !== null) {
            await manager.saveDocument(id);
          }
        },
        isEnabled: hasActiveDocument,
      }),
      registry.register("file.saveAs", {
        execute: async () => {
          const id = manager.getActiveDocumentId();
          if (id !== null) {
            await manager.saveDocumentAs(id);
          }
        },
        isEnabled: hasActiveDocument,
      }),
      registry.register("file.close", {
        execute: async () => {
          const id = manager.getActiveDocumentId();
          if (id !== null) {
            await manager.closeDocument(id);
          }
        },
        isEnabled: hasActiveDocument,
      }),
      registry.register("app.exit", {
        execute: async () => {
          // Exit asks the manager once, then destroys directly: the normal
          // last-Tab behaviour must not run during application exit.
          if (await manager.prepareCloseAll()) {
            await getCurrentWindow().destroy();
          }
        },
      }),
      registry.register("editor.undo", {
        execute: () => {
          editorHandle.undo();
        },
        isEnabled: hasActiveDocument,
      }),
      registry.register("editor.redo", {
        execute: () => {
          editorHandle.redo();
        },
        isEnabled: hasActiveDocument,
      }),
      registry.register("workspace.openFolder", {
        execute: async () => {
          const result = await workContext.openFromDialog();
          if (result.status === "opened" || result.status === "unchanged") {
            // An equivalent root is a no-op inside the controller, so the
            // user's expansion and selection survive a duplicate request.
            controller.setContext(result.context);
            // The candidate root was read successfully, which proves it is
            // reachable again: a previous unavailable state and its error row
            // must not outlive that recovery (FR-088).
            controller.markRootAvailable();
          }
        },
      }),
      registry.register("workspace.closeFolder", {
        execute: () => {
          workContext.close();
          controller.setContext(null);
        },
        isEnabled: () => workContext.getContext() !== null,
      }),
      registry.register("explorer.newFile", {
        execute: () => actions.newFile(),
        isEnabled: () => actions.isCreateAvailable(),
      }),
      registry.register("explorer.newFolder", {
        execute: () => actions.newFolder(),
        isEnabled: () => actions.isCreateAvailable(),
      }),
      registry.register("explorer.rename", {
        execute: () => {
          actions.rename();
        },
        isEnabled: () => actions.isRenameAvailable(),
      }),
      registry.register("explorer.delete", {
        execute: () => actions.delete(),
        isEnabled: () => actions.isDeleteAvailable(),
      }),
      registry.register("explorer.refresh", {
        execute: () => actions.refresh(),
        isEnabled: () => actions.isRefreshAvailable(),
      }),
      registry.register("view.toggleExplorer", {
        execute: () => {
          setLayout((current) => ({
            ...current,
            sidebarVisible: !current.sidebarVisible,
          }));
        },
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
     * A recognized shortcut is consumed even when its command is disabled
     * (FR-022): the key does not leak into another handler, and the disabled
     * handler is never called.
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
    let disposeFocus: (() => void) | null = null;

    const installNativeSurfaces = async (): Promise<void> => {
      if (!isTauriRuntime()) {
        return;
      }

      const appWindow = getCurrentWindow();
      const stopWindowLifecycle = await installWindowLifecycle(
        manager,
        appWindow,
      );

      // 005 fallback trigger (FR-012): regaining focus revalidates every bound
      // document through the cheap inspection path. The handler deliberately does
      // not await any disk work, and it is not coupled to the Explorer, so
      // returning from another program can neither freeze the UI nor rescan the
      // Workspace (FR-040, SC-008).
      const unlistenFocus = await appWindow.onFocusChanged(({ payload }) => {
        if (payload) {
          watcher.validateAllOnWindowFocus();
        }
      });

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
        // its own failures, and dropped directories are ignored without
        // touching the Workspace or the Explorer.
        void processDroppedPaths(payload.paths, manager);
      });

      const installation = await installAppMenu({
        executeCommand: (id: CommandId) => registry.execute(id),
        onCommandError: (error: unknown) => {
          void nativeFileDialogService.showError(describeError(error));
        },
        isCommandEnabled: (id: CommandId) => registry.isEnabled(id),
      });

      // React Strict Mode mounts, unmounts and mounts again; an installation
      // that lost the race has to clean itself up rather than leak a menu, a
      // close listener or a drag/drop listener.
      if (disposed) {
        stopWindowLifecycle();
        unlistenDragDrop();
        unlistenFocus();
        await installation.restore();
        return;
      }

      disposeWindow = stopWindowLifecycle;
      disposeDragDrop = unlistenDragDrop;
      disposeFocus = unlistenFocus;
      disposeMenu = installation.restore;
      menuRef.current = installation;
      await installation.syncAvailability();
    };

    void installNativeSurfaces();

    return () => {
      disposed = true;
      menuRef.current = null;
      window.removeEventListener("keydown", onKeyDown, true);
      editorHandle.setStateUpdateListener(null);
      unsubscribeDocuments();
      unsubscribeExplorer();
      unsubscribeWorkspace();

      for (const unregister of unregisterHandlers) {
        unregister();
      }

      disposeDragDrop?.();
      disposeFocus?.();
      disposeWindow?.();
      void disposeMenu?.();
      void watcher.dispose();
    };
  }, [
    actions,
    benchmark,
    controller,
    editorHandle,
    manager,
    registry,
    watcher,
    workContext,
  ]);

  // Menu state has to follow document, Workspace and Explorer operation state,
  // because availability now depends on all three.
  useEffect(() => {
    void menuRef.current?.syncAvailability();
  }, [explorerState, snapshot, workspaceName]);

  const activeSession =
    snapshot.activeDocumentId === null
      ? null
      : (manager.getSession(snapshot.activeDocumentId) ?? null);

  return (
    <AppShell
      sidebar={
        <Explorer
          state={explorerState}
          controller={controller}
          workspaceName={workspaceName}
          actions={actions}
          onOpenFolder={() => {
            dispatch("workspace.openFolder");
          }}
          onCommand={dispatch}
        />
      }
      editorArea={
        <>
          <TabBar
            tabs={snapshot.tabs}
            onSelect={(id) => {
              manager.selectDocument(id);
            }}
            onClose={(id) => {
              void manager.closeDocument(id);
            }}
            onNew={() => {
              dispatch("file.new");
            }}
          />

          <div className="editor-host-area">
            {activeSession === null ? (
              <EmptyState
                workspaceName={workspaceName}
                onOpenFile={() => {
                  dispatch("file.open");
                }}
                onOpenFolder={() => {
                  dispatch("workspace.openFolder");
                }}
              />
            ) : (
              <Editor
                handle={editorHandle}
                documentId={activeSession.id}
                initialState={activeSession.editorState}
              />
            )}
            {isFileDragActive ? (
              <div className="drop-overlay" aria-hidden="true" />
            ) : null}
          </div>
        </>
      }
      sidebarVisible={layout.sidebarVisible}
      sidebarWidth={layout.sidebarWidth}
      onSidebarWidthChange={(width) => {
        setLayout((current) => ({
          ...current,
          sidebarWidth: clampSidebarWidth(width),
        }));
      }}
    />
  );
}
