import type { ActiveDocumentSession } from "../document/documentSession";

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

/** Everything the window lifecycle needs from the document session. */
export interface WindowLifecycleSource {
  getSession(): ActiveDocumentSession;
  subscribe(listener: (session: ActiveDocumentSession) => void): () => void;
  /** The shared unsaved-work guard; `true` means the action may proceed. */
  runUnsavedGuard(): Promise<boolean>;
}

export interface CloseRequestDeps {
  isDocumentDirty(): boolean;
  runUnsavedGuard(): Promise<boolean>;
  /**
   * Forced destroy. `destroy()` bypasses close-request interception, which is
   * what keeps an approved close from re-entering this handler.
   */
  destroyWindow(): Promise<void>;
}

/** `Untitled - Sorakada`, `foo.txt - Sorakada` or `*foo.txt - Sorakada`. */
export function formatWindowTitle(session: ActiveDocumentSession): string {
  const dirtyMarker = session.dirty ? "*" : "";
  return `${dirtyMarker}${session.displayName} - ${APP_NAME}`;
}

/**
 * Dirty-aware native close interception.
 *
 * A clean document closes untouched. A dirty one immediately blocks the native
 * close, then runs the same unsaved guard Exit uses, and force-destroys the
 * window only once that guard approves.
 */
export async function handleCloseRequested(
  event: CloseRequestedLike,
  deps: CloseRequestDeps,
): Promise<void> {
  if (!deps.isDocumentDirty()) {
    return;
  }

  event.preventDefault();

  if (await deps.runUnsavedGuard()) {
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
  const syncTitle = (session: ActiveDocumentSession): void => {
    // Title feedback is cosmetic: a failure here must not break the lifecycle.
    void appWindow.setTitle(formatWindowTitle(session)).catch(() => {});
  };

  await appWindow.setTitle(formatWindowTitle(source.getSession()));

  const unsubscribe = source.subscribe(syncTitle);

  const unlisten = await appWindow.onCloseRequested((event) =>
    handleCloseRequested(event, {
      isDocumentDirty: () => source.getSession().dirty,
      runUnsavedGuard: () => source.runUnsavedGuard(),
      destroyWindow: () => appWindow.destroy(),
    }),
  );

  return () => {
    unsubscribe();
    unlisten();
  };
}
