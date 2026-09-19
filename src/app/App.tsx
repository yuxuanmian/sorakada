/**
 * Application shell.
 *
 * The application has two independent axes: zero or one active Workspace, and
 * zero or more open documents. React owns the UI and the lightweight metadata;
 * `DocumentManager` owns documents, `WorkContextManager` owns the Workspace
 * identity, `ExplorerController` owns the transient Tree state, CodeMirror owns
 * the live text, and Rust owns the filesystem. This component only wires those
 * together, registers command handlers, and composes the shell:
 *
 * ```text
 * OverlayRoot
 * └── AppShell
 *     ├── TopBar (App Menu + window chrome)
 *     ├── MainArea (Sidebar + EditorWorkspace > EditorGroup > TabStrip + EditorHost)
 *     └── FooterBar
 * ```
 *
 * 007 keeps the persisted UI preferences (`UiPreferencesStore`) and the
 * development diagnostics (`UiDebugOptionsStore`) as the only new owners, and
 * deliberately does **not** add document or Tree state here.
 */
import { useCallback, useEffect, useState } from "react";
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
import type {
  DocumentId,
  DocumentManagerSnapshot,
  TabSnapshot,
} from "./document/documentSession";
import { InternalFsOperationGuard } from "./document/internalFsOperationGuard";
import { OpenedDocumentWatchCoordinator } from "./document/openedDocumentWatchCoordinator";
import { processDroppedPaths } from "./dragdrop/fileDropController";
import { Explorer } from "./explorer/Explorer";
import { ExplorerActions } from "./explorer/explorerActions";
import { ExplorerController } from "./explorer/explorerController";
import {
  isLocateAvailable,
  type ExplorerHeaderState,
} from "./explorer/explorerHeaderActions";
import { locateCurrentFile, type LocateRequest } from "./explorer/explorerLocate";
import {
  createEmptyExplorerState,
  type ExplorerState,
} from "./explorer/explorerModel";
import { CompactAppMenu } from "./menu/CompactAppMenu";
import {
  createActivationBenchmark,
  installActivationBenchmark,
} from "./performance/activationBenchmark";
import {
  activateFixtureTab,
  closeFixtureTab,
  createHundredTabSnapshots,
  isFixtureDocumentId,
} from "./performance/tabFixtures";
import { createTenThousandRowExplorerTree } from "./performance/treeFixtures";
import { AppShell } from "./shell/AppShell";
import { applyDensityAttribute, densityMetrics } from "./shell/density";
import { EditorGroup } from "./shell/EditorGroup";
import { EditorWorkspace } from "./shell/EditorWorkspace";
import { EmptyState } from "./shell/EmptyState";
import { FooterBar } from "./shell/FooterBar";
import { FooterLeft, FooterRight } from "./shell/FooterContext";
import { projectFooter } from "./shell/footerProjection";
import { TopBar } from "./shell/TopBar";
import {
  createUiDebugOptionsStore,
  isUiDebugAvailable,
} from "./shell/uiDebugState";
import {
  createUiPreferencesStore,
  type UiPreferences,
} from "./shell/uiPreferences";
import {
  createTauriWindowChromeAdapter,
  createWindowChromeController,
} from "./shell/windowChrome";
import { OverlayRoot } from "../ui/overlay/OverlayRoot";
import { TabStrip } from "./tabs/TabStrip";
import { installWindowLifecycle } from "./window/windowLifecycle";
import { WorkContextManager } from "./workspace/workContextManager";
import { WorkspaceWatchCoordinator } from "./workspace/workspaceWatchCoordinator";

import "../styles/global.css";
import "../styles/density.css";

/**
 * Whether the page is running inside the Tauri desktop shell.
 *
 * Native window control, dialogs and drag/drop only exist there; a plain browser
 * `vite dev` session must still render the editor instead of failing on a missing
 * IPC bridge (FR-024, US1-AC8).
 */
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reports a failure through the application's existing error surface. */
function reportError(error: unknown): void {
  void nativeFileDialogService.showError(describeError(error));
}

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
  /**
   * 006: the Workspace watcher consumer.
   *
   * It sits *beside* the opened-document consumer, shares the same generic
   * watcher, WorkContext and Explorer instances, and owns none of their facts: it
   * only turns hints into bounded reconciliation requests.
   */
  const [workspaceWatcher] = useState(
    () =>
      new WorkspaceWatchCoordinator({
        workContexts: workContext,
        explorer: controller,
        documents: manager,
        watcher: tauriFilesystemWatcher,
      }),
  );

  /**
   * 007: the two new UI-only owners.
   *
   * `UiPreferencesStore` owns density and Sidebar layout; `UiDebugOptionsStore`
   * owns process-local diagnostics and is never persisted (FR-085, FR-089).
   */
  const [preferencesStore] = useState(createUiPreferencesStore);
  const [debugStore] = useState(createUiDebugOptionsStore);
  const [developer] = useState(isUiDebugAvailable);

  /**
   * 007: custom window chrome.
   *
   * The Tauri window is reached exactly once, here, and only when the runtime
   * actually has one, so no component can call `getCurrentWindow()` and no
   * browser-only session can attempt an unavailable IPC call (T038, FR-007).
   */
  const [chrome] = useState(() =>
    createWindowChromeController({
      adapter: isTauriRuntime()
        ? createTauriWindowChromeAdapter(getCurrentWindow())
        : null,
      onError: reportError,
    }),
  );

  const [snapshot, setSnapshot] = useState<DocumentManagerSnapshot>(() =>
    manager.getSnapshot(),
  );
  /**
   * Whether the command registry has been populated.
   *
   * Handlers are registered in the mount effect below, i.e. after the first render,
   * so the first render's output describes an application in which no command exists
   * yet — every menu surface would read "unavailable". This flag re-renders the
   * shell once registration has happened, so that state is gone before the user can
   * interact with anything (FR-022).
   */
  const [commandsRegistered, setCommandsRegistered] = useState(false);
  const [explorerState, setExplorerState] = useState<ExplorerState>(
    createEmptyExplorerState,
  );
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<UiPreferences>(() =>
    preferencesStore.getSnapshot(),
  );
  const [debugOptions, setDebugOptions] = useState(() =>
    debugStore.getSnapshot(),
  );
  /**
   * Development-only scale harnesses (T182, T183).
   *
   * They hold the shared disposable fixtures — 10,000 materialized Explorer rows
   * and 100 Tab snapshots — and are `null` unless a developer turns them on, so a
   * production build renders the real state and no fixture is ever constructed.
   */
  const [debugTreeFixture, setDebugTreeFixture] = useState<ExplorerState | null>(
    null,
  );
  const [debugTabFixture, setDebugTabFixture] = useState<
    readonly TabSnapshot[] | null
  >(null);
  const [maximized, setMaximized] = useState(false);
  /**
   * A pending Locate reveal, addressed by logical row key.
   *
   * The request is one-shot UI state: Locate derives the target from document and
   * Workspace identity, and the Tree is the only component that can act on it.
   */
  const [revealRequest, setRevealRequest] = useState<{ key: string } | null>(
    null,
  );

  // Purely visual: the manager owns what a drop actually does.
  const [isFileDragActive, setIsFileDragActive] = useState(false);

  /** Runs a command and reports anything that escapes its handler. */
  const dispatch = useCallback(
    (id: CommandId): void => {
      void registry.execute(id).catch(reportError);
    },
    [registry],
  );

  /*
   * Tab gestures, routed by Tab *identity* rather than by "is the fixture on"
   * (T227).
   *
   * A fixture Tab id names no `DocumentSession`, so while the disposable fixture is
   * rendered its active Tab is fixture-owned UI state: selecting moves exactly one
   * fixture Tab, closing removes one harmlessly, and neither gesture can reach
   * `DocumentManager`. Real document ids keep the normal path unchanged, and a
   * fixture id stays a fixture id even if a gesture arrives after the fixture was
   * switched off, so no stale id can leak into a real close.
   */
  const selectTab = useCallback(
    (id: DocumentId): void => {
      if (isFixtureDocumentId(id)) {
        setDebugTabFixture((current) =>
          current === null ? current : activateFixtureTab(current, id),
        );
        return;
      }
      manager.selectDocument(id);
    },
    [manager],
  );

  const closeTab = useCallback(
    (id: DocumentId): void => {
      if (isFixtureDocumentId(id)) {
        setDebugTabFixture((current) =>
          current === null ? current : closeFixtureTab(current, id),
        );
        return;
      }
      void manager.closeDocument(id);
    },
    [manager],
  );

  // The UI owners publish through their own subscribe API; components never touch
  // storage or a diagnostic flag directly (FR-086, FR-089).
  useEffect(() => {
    const unsubscribePreferences = preferencesStore.subscribe(setPreferences);
    const unsubscribeDebug = debugStore.subscribe(setDebugOptions);
    return () => {
      unsubscribePreferences();
      unsubscribeDebug();
    };
  }, [debugStore, preferencesStore]);

  /*
   * Density is published as a root data attribute, which is what selects the
   * token set in `density.css`. Switching it is one attribute write, so no
   * document, Explorer or editor state is remounted (FR-080, T034, T156).
   */
  useEffect(() => {
    applyDensityAttribute(preferences.density, document.documentElement);
  }, [preferences.density]);

  /*
   * The maximize/restore glyph is view state only. The native answer is re-read
   * after a gesture and after any window resize, which also covers a maximize
   * performed by the OS (snap, Win+Up) rather than by our control.
   */
  useEffect(() => {
    let disposed = false;
    const refresh = (): void => {
      void chrome.refreshMaximized().then((value) => {
        if (!disposed) {
          setMaximized(value);
        }
      });
    };

    refresh();
    window.addEventListener("resize", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("resize", refresh);
    };
  }, [chrome]);

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

    // 006: the Workspace consumer starts after the document consumer, so both
    // listen on the same channel before any payload can arrive.
    void workspaceWatcher.start();

    // The bridge reports every state update with the document it was bound to,
    // which is what keeps a Tab switch from being credited to the wrong Tab.
    editorHandle.setStateUpdateListener((documentId, state, docChanged) => {
      manager.handleEditorStateUpdate(documentId, state, docChanged);
    });

    const hasActiveDocument = (): boolean =>
      manager.getActiveDocumentId() !== null;

    /**
     * The Locate intent, or `null` when the active document is not meaningfully
     * locatable in the current Workspace.
     *
     * This is the single availability authority for `explorer.locateCurrentFile`:
     * the Header reads it through the registry, and the handler re-reads it at
     * execution time, so a stale control cannot start a locate (FR-051, T114).
     */
    const locateIntent = (): LocateRequest | null => {
      const id = manager.getActiveDocumentId();
      if (id === null) {
        return null;
      }
      const session = manager.getSession(id) ?? null;
      const context = workContext.getContext();
      if (
        session === null ||
        session.path === null ||
        session.pathIdentity === null ||
        context === null
      ) {
        return null;
      }

      const available = isLocateAvailable({
        hasWorkspace: true,
        hasExpandedDirectories: false,
        activeDocumentPathKey: session.pathIdentity.comparisonKey,
        workspaceComparisonKey: context.comparisonKey,
      });
      if (!available) {
        return null;
      }

      return {
        documentId: id,
        path: session.path,
        pathKey: session.pathIdentity.comparisonKey,
        contextId: context.id,
      };
    };

    // Commands carry no business logic of their own: they only forward to the
    // manager, the Workspace, the Explorer actions, the preference owner or the
    // window-chrome controller, which keeps menu, accelerator, context-menu,
    // TopBar and keyboard surfaces equivalent by construction. Availability is
    // declared once, here, and every surface reads it from the same registry.
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
          // last-Tab behaviour must not run during application exit. This is the
          // one approved forced-destroy path, and it runs only after the guard
          // approved the close (FR-008, T197).
          if (await manager.prepareCloseAll()) {
            await getCurrentWindow().destroy();
          }
        },
        // Exit is a native window operation, so it is offered exactly when native
        // window control exists — the same runtime gate the window controls use.
        // Without this a browser-only session could reach `destroy()` on an
        // unavailable Tauri API (T224, T063, FR-024).
        isEnabled: () => chrome.isAvailable(),
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
      // 007 Explorer navigation. Both are explicit user requests that may only
      // read what is already represented, one level at a time (FR-052, FR-054).
      registry.register("explorer.collapseAll", {
        execute: () => {
          controller.collapseAll();
        },
        isEnabled: () => controller.hasExpandedDescendants(),
      }),
      registry.register("explorer.locateCurrentFile", {
        execute: async () => {
          const request = locateIntent();
          if (request === null) {
            return;
          }
          const outcome = await locateCurrentFile(request, {
            tree: controller,
            // The intent is stale as soon as the active document or the
            // Workspace is replaced, so a completion can never select a path in
            // the new state (FR-052).
            isCurrent: (candidate) =>
              manager.getActiveDocumentId() === candidate.documentId &&
              workContext.getContext()?.id === candidate.contextId,
          });
          if (outcome.status === "located") {
            setRevealRequest({ key: outcome.path });
          }
          // A rejected locate changes nothing at all: no Explorer read beyond the
          // ancestor chain, no document state, and no recursive fallback search
          // (FR-053).
        },
        isEnabled: () => locateIntent() !== null,
      }),
      registry.register("view.toggleExplorer", {
        execute: () => {
          // The preference owner is the single writer of Sidebar visibility
          // (FR-085); the toggle only expresses the intent.
          preferencesStore.setSidebarVisible(
            !preferencesStore.getSnapshot().sidebarVisible,
          );
        },
      }),
      registry.register("view.resetSidebarWidth", {
        execute: () => {
          // Reset restores the *density default* through the preference owner,
          // so the value is never hard-coded in a menu callback (T154).
          preferencesStore.setSidebarWidth(
            densityMetrics(preferencesStore.getSnapshot().density)
              .sidebarDefaultWidth,
          );
        },
      }),
      registry.register("view.densityCompact", {
        execute: () => {
          preferencesStore.setDensity("compact");
        },
      }),
      registry.register("view.densityDefault", {
        execute: () => {
          preferencesStore.setDensity("default");
        },
      }),
      registry.register("view.densityComfortable", {
        execute: () => {
          preferencesStore.setDensity("comfortable");
        },
      }),
      // Development diagnostics are ordinary commands too, so their clickable
      // menu toggles share the one execution path (T065, FR-096). They are
      // omitted from a production build's menu, not from the registry.
      registry.register("view.toggleVirtualRange", {
        execute: () => {
          debugStore.toggleOption("showVirtualRange");
        },
      }),
      registry.register("view.toggleTreeRowBounds", {
        execute: () => {
          debugStore.toggleOption("showTreeRowBounds");
        },
      }),
      registry.register("view.debugLargeTree", {
        execute: () => {
          setDebugTreeFixture((current) =>
            current === null ? createTenThousandRowExplorerTree() : null,
          );
        },
      }),
      registry.register("view.debugManyTabs", {
        execute: () => {
          setDebugTabFixture((current) =>
            current === null ? createHundredTabSnapshots() : null,
          );
        },
      }),
      // 007 window chrome: the visible controls dispatch these ids, and
      // availability follows the runtime's capability (T039, FR-007).
      registry.register("window.minimize", {
        execute: () => chrome.minimize(),
        isEnabled: () => chrome.isAvailable(),
      }),
      registry.register("window.toggleMaximize", {
        execute: async () => {
          setMaximized(await chrome.toggleMaximize());
        },
        isEnabled: () => chrome.isAvailable(),
      }),
      registry.register("window.close", {
        execute: () => chrome.requestClose(),
        isEnabled: () => chrome.isAvailable(),
      }),
    ];

    // Every command now has a handler, so the shell re-renders once with real
    // availability. Without this the first render's menu models — built while the
    // registry was still empty — would be the ones an early interaction saw.
    setCommandsRegistered(true);

    /**
     * The application shortcut dispatcher — the single route for the IDEA
     * profile.
     *
     * This lives here rather than on a native menu item because Tauri's menu
     * accelerators are not translated into menu commands while the WebView2 has
     * focus: the keystroke is delivered to the page instead, so a native
     * accelerator would silently do nothing. The compact App Menu therefore only
     * *displays* the shortcuts, and this handler performs them.
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
      void registry.execute(commandId).catch(reportError);
    };

    window.addEventListener("keydown", onKeyDown, true);

    let disposed = false;
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
        { onError: reportError },
      );

      // 005 fallback trigger (FR-012): regaining focus revalidates every bound
      // document through the cheap inspection path. The handler deliberately does
      // not await any disk work, and it is not coupled to the Explorer, so
      // returning from another program can neither freeze the UI nor rescan the
      // Workspace (FR-040, SC-008).
      const unlistenFocus = await appWindow.onFocusChanged(({ payload }) => {
        if (payload) {
          watcher.validateAllOnWindowFocus();
          // 006 focus regain (FR-079): request one bounded reconciliation of the
          // currently relevant expanded Workspace area. Like the 005 call it
          // schedules only and never awaits filesystem work.
          workspaceWatcher.notifyFocusRegained();
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

      // React Strict Mode mounts, unmounts and mounts again; an installation that
      // lost the race has to clean itself up rather than leak a close listener or
      // a drag/drop listener.
      if (disposed) {
        stopWindowLifecycle();
        unlistenDragDrop();
        unlistenFocus();
        return;
      }

      disposeWindow = stopWindowLifecycle;
      disposeDragDrop = unlistenDragDrop;
      disposeFocus = unlistenFocus;
    };

    // A native surface that cannot be installed is reported through the existing
    // error path instead of becoming an unhandled rejection — a refused window
    // permission must be visible, and it must not silently remove the close guard
    // (`installWindowLifecycle` keeps the guard even when a title write fails).
    void installNativeSurfaces().catch(reportError);

    return () => {
      disposed = true;
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
      void watcher.dispose();
      // Both consumers are disposed exactly once per mounted lifecycle, in the
      // same restart-safe style, so React Strict Mode cannot leave a second
      // Workspace listener or timer behind.
      void workspaceWatcher.dispose();
    };
  }, [
    actions,
    benchmark,
    chrome,
    controller,
    debugStore,
    editorHandle,
    manager,
    preferencesStore,
    registry,
    watcher,
    workContext,
    workspaceWatcher,
  ]);

  const activeSession =
    snapshot.activeDocumentId === null
      ? null
      : (manager.getSession(snapshot.activeDocumentId) ?? null);

  /**
   * The Workspace/document facts the Explorer Header's availability depends on.
   *
   * Deriving them here keeps the Header a presentation component and keeps the
   * registry's predicate and the visible button state on the same facts (T124).
   */
  const explorerHeaderState: ExplorerHeaderState = {
    hasWorkspace: workspaceName !== null,
    hasExpandedDirectories: controller.hasExpandedDescendants(),
    activeDocumentPathKey: activeSession?.pathIdentity?.comparisonKey ?? null,
    workspaceComparisonKey: workContext.getContext()?.comparisonKey ?? null,
  };

  /**
   * The Footer is a projection of facts that already exist — the active
   * `WorkContext`, the active session and its canonical path key — so it never
   * stores a second path copy and it updates from the same snapshot every other
   * surface reads (T167, T172).
   */
  const activeWorkspace = workContext.getContext();
  const footerProjection = projectFooter({
    workspace:
      activeWorkspace === null
        ? null
        : {
            rootPath: activeWorkspace.rootPath,
            comparisonKey: activeWorkspace.comparisonKey,
            displayName: activeWorkspace.displayName,
          },
    document:
      activeSession === null
        ? null
        : {
            displayName: activeSession.displayName,
            path: activeSession.path,
            pathKey: activeSession.pathIdentity?.comparisonKey ?? null,
            format: activeSession.format,
          },
  });

  return (
    <OverlayRoot>
      <AppShell
        topBar={
          <TopBar
            appMenu={
              <CompactAppMenu
                isEnabled={(id) => commandsRegistered && registry.isEnabled(id)}
                developer={developer}
                onCommand={dispatch}
              />
            }
            onCommand={dispatch}
            onStartDrag={() => {
              void chrome.startDragging();
            }}
            nativeChromeAvailable={chrome.isAvailable()}
            maximized={maximized}
          />
        }
        sidebar={
          <Explorer
            state={explorerState}
            controller={controller}
            workspaceName={workspaceName}
            actions={actions}
            metrics={densityMetrics(preferences.density)}
            headerState={explorerHeaderState}
            debugOptions={debugOptions}
            debugState={debugTreeFixture}
            revealRequest={revealRequest}
            onRevealHandled={() => {
              setRevealRequest(null);
            }}
            isCommandEnabled={(id) => commandsRegistered && registry.isEnabled(id)}
            onOpenFolder={() => {
              dispatch("workspace.openFolder");
            }}
            onCommand={dispatch}
          />
        }
        editor={
          <EditorWorkspace>
            <EditorGroup
              tabStrip={
                <TabStrip
                  tabs={debugTabFixture ?? snapshot.tabs}
                  metrics={densityMetrics(preferences.density)}
                  forceOverview={debugTabFixture !== null}
                  onSelect={selectTab}
                  onClose={closeTab}
                  onNew={() => {
                    dispatch("file.new");
                  }}
                />
              }
            >
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
            </EditorGroup>
          </EditorWorkspace>
        }
        footer={
          <FooterBar
            left={<FooterLeft context={footerProjection.left} />}
            right={<FooterRight items={footerProjection.right} />}
          />
        }
        sidebarVisible={preferences.sidebarVisible}
        sidebarWidth={preferences.sidebarWidth}
        onSidebarWidthChange={(requestedWidth) => {
          // The *request* is stored; rendering applies the MainArea clamp, so a
          // narrow window can never overwrite the preferred width (T153).
          preferencesStore.setSidebarWidth(requestedWidth);
        }}
      />
    </OverlayRoot>
  );
}
