import type {
  DocumentManagerSnapshot,
  DocumentSession,
} from "../document/documentSession";
import { localizedDocumentName } from "../../i18n/documentName";
import { ExitCoordinator } from "./exitCoordinator";

export { ExitCoordinator } from "./exitCoordinator";
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

export interface WindowLifecycleSource {
  getActiveSession(): DocumentSession | null;
  hasDirtyDocuments(): boolean;
  prepareCloseAll(): Promise<boolean>;
  subscribe(listener: (snapshot: DocumentManagerSnapshot) => void): () => void;
}

export interface CloseRequestDeps {
  hasDirtyDocuments(): boolean;
  prepareCloseAll(): Promise<boolean>;
  destroyWindow(): Promise<void>;
  exitCoordinator?: ExitCoordinator;
}

export interface WindowLifecycleOptions {
  onError?(error: unknown): void;
  exitCoordinator?: ExitCoordinator;
}

export function formatWindowTitle(
  session: { path?: string | null; displayName: string; dirty: boolean } | null,
): string {
  if (session === null) {
    return APP_NAME;
  }

  const name = localizedDocumentName({
    path: session.path ?? null,
    displayName: session.displayName,
  });
  const dirtyMarker = session.dirty ? "*" : "";
  return dirtyMarker + name + " - " + APP_NAME;
}

export async function handleCloseRequested(
  event: CloseRequestedLike,
  deps: CloseRequestDeps,
): Promise<void> {
  if (deps.exitCoordinator) {
    event.preventDefault();
    await deps.exitCoordinator.requestExit();
    return;
  }

  if (!deps.hasDirtyDocuments()) {
    return;
  }

  event.preventDefault();

  if (await deps.prepareCloseAll()) {
    await deps.destroyWindow();
  }
}

export async function installWindowLifecycle(
  source: WindowLifecycleSource,
  appWindow: AppWindowLike,
  options: WindowLifecycleOptions = {},
): Promise<() => void> {
  const syncTitle = (): void => {
    void appWindow
      .setTitle(formatWindowTitle(source.getActiveSession()))
      .catch((error: unknown) => {
        options.onError?.(error);
      });
  };

  try {
    await appWindow.setTitle(formatWindowTitle(source.getActiveSession()));
  } catch (error) {
    options.onError?.(error);
  }

  const unsubscribe = source.subscribe(syncTitle);

  const unlisten = await appWindow.onCloseRequested((event) =>
    handleCloseRequested(event, {
      hasDirtyDocuments: () => source.hasDirtyDocuments(),
      prepareCloseAll: () => source.prepareCloseAll(),
      destroyWindow: () => appWindow.destroy(),
      exitCoordinator: options.exitCoordinator,
    }),
  );

  return () => {
    unsubscribe();
    unlisten();
  };
}