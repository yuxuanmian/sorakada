import type {
  DocumentManagerSnapshot,
  DocumentSession,
} from "../document/documentSession";

/** The application name shown in the window title. */
export const APP_NAME = "Sorakada";

/** Minimal view of the close-request event the handler needs. */
export interface CloseRequestedLike {
  preventDefault(): void;
}

/** Minimal surface of the native window used by the lifecycle. */
export interface AppWindowLike {
  setTitle(title: string): Promise<void>;
  destroy(): Promise<void>;
  onCloseRequested(
    handler: (event: CloseRequestedLike) => void | Promise<void>,
  ): Promise<() => void>;
}

/**
 * Everything the window lifecycle needs from the document manager.
 *
 * The lifecycle never decides whether a Tab may close: it asks the manager for
 * the close-all decision, which owns the unsaved-work prompts.
 */
export interface WindowLifecycleSource {
  /** The document whose name and dirty flag the title shows; `null` when none. */
  getActiveSession(): DocumentSession | null;
  /** Whether any open document differs from its saved baseline. */
  hasDirtyDocuments(): boolean;
  /** `true` only when every dirty document's decision permits destroying the window. */
  prepareCloseAll(): Promise<boolean>;
  /** Fires whenever Tab-visible metadata changes. */
  subscribe(listener: (snapshot: DocumentManagerSnapshot) => void): () => void;
}

export interface CloseRequestDeps {
  hasDirtyDocuments(): boolean;
  prepareCloseAll(): Promise<boolean>;
  /**
   * Forced destroy. `destroy()` bypasses close-request interception, which is
   * what keeps an approved close from re-entering this handler.
   */
  destroyWindow(): Promise<void>;
}

/**
 * `Untitled1 - Sorakada`, `foo.txt - Sorakada`, `*foo.txt - Sorakada`, or plain
 * `Sorakada` while no document is open.
 *
 * Zero documents is a valid state in 003, so the title has to describe the
 * application itself rather than a document that does not exist.
 */
export function formatWindowTitle(
  session: { displayName: string; dirty: boolean } | null,
): string {
  if (session === null) {
    return APP_NAME;
  }

  const dirtyMarker = session.dirty ? "*" : "";
  return `${dirtyMarker}${session.displayName} - ${APP_NAME}`;
}

/**
 * Dirty-aware native close interception.
 *
 * A window with no unsaved work closes untouched. Otherwise the native close is
 * blocked immediately, the manager's close-all guard runs exactly once, and the
 * window is force-destroyed only when that guard approves. The normal "replace
 * the last Tab" rule deliberately does not run here.
 */
export async function handleCloseRequested(
  event: CloseRequestedLike,
  deps: CloseRequestDeps,
): Promise<void> {
  if (!deps.hasDirtyDocuments()) {
    return;
  }

  event.preventDefault();

  if (await deps.prepareCloseAll()) {
    await deps.destroyWindow();
  }
}

/**
 * Wires window-title synchronisation and close interception to a native window.
 * Returns the disposer that unsubscribes both.
 */
export async function installWindowLifecycle(
  source: WindowLifecycleSource,
  appWindow: AppWindowLike,
): Promise<() => void> {
  const syncTitle = (): void => {
    // Title feedback is cosmetic: a failure here must not break the lifecycle.
    void appWindow
      .setTitle(formatWindowTitle(source.getActiveSession()))
      .catch(() => {});
  };
  await appWindow.setTitle(formatWindowTitle(source.getActiveSession()));

  const unsubscribe = source.subscribe(syncTitle);

  const unlisten = await appWindow.onCloseRequested((event) =>
    handleCloseRequested(event, {
      hasDirtyDocuments: () => source.hasDirtyDocuments(),
      prepareCloseAll: () => source.prepareCloseAll(),
      destroyWindow: () => appWindow.destroy(),
    }),
  );

  return () => {
    unsubscribe();
    unlisten();
  };
}
