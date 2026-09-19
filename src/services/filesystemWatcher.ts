/**
 * Frontend adapter for the reusable Rust filesystem watcher.
 *
 * The backend owns OS watching and emits *normalized hints*; this module only
 * translates the IPC contract. It deliberately knows nothing about documents:
 * it never touches `DocumentSession`, `DocumentManager` or CodeMirror, so an
 * event can never mutate editor state directly (FR-037). The opened-document
 * consumer lives in `app/document/openedDocumentWatchCoordinator.ts`.
 *
 * The DTOs below mirror `src-tauri/src/watch_event.rs` field for field; the Rust
 * side pins the same JSON with `serde_json`, so a camelCase drift on either side
 * fails a test rather than surfacing at runtime.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** How much of the filesystem a subscription observes. 005 only uses `nonRecursive`. */
export type WatchScope = "nonRecursive" | "recursive";

/**
 * The generic change a normalized hint describes.
 *
 * These are hints, not transitions: every one of them still has to be validated
 * against the current disk state before a document changes (FR-007).
 */
export type WatchChangeHint = "created" | "changed" | "removed" | "other";

/** One normalized filesystem hint concerning a subscribed path. */
export interface WatchEvent {
  subscriptionId: number;
  scope: WatchScope;
  /** The directory actually watched on the backend. */
  watchedPath: string;
  /** The path the hint refers to. */
  path: string;
  hint: WatchChangeHint;
  /**
   * The destination of an observed rename pair.
   *
   * The Workspace consumer may offer it as a source/target *candidate*, which
   * can narrow an identity match; it is never rename proof, and 005 must never
   * treat it as an opened-document path migration.
   */
  renameTarget: string | null;
  /**
   * `path` relative to this subscription's watched directory (006).
   *
   * The backend watches a canonical directory spelling that can differ from the
   * logical Workspace root the user chose, so 006 rebases this under
   * `WorkContext.rootPath` instead of comparing raw watcher path text against
   * Tree paths. `null` means the event path is not inside the watched directory.
   * 005 ignores it.
   */
  relativePath: string | null;
  /**
   * `renameTarget` relative to the watched directory, or `null`.
   *
   * `null` when there is no target *or* when the target lies outside the watch:
   * an outside target is a document-only relocation candidate and must never be
   * used as an Explorer path.
   */
  renameTargetRelativePath: string | null;
}

/**
 * The backend can no longer guarantee that its event stream is complete for a
 * scope, so interests there must be revalidated instead of trusted (FR-038).
 */
export interface WatchInvalidated {
  scope: WatchScope;
  /** The affected watched directory; `null` means "every interest". */
  watchedPath: string | null;
  reason: string;
}

/** The single event channel payload, tagged by `type`. */
export type WatchEventPayload =
  | ({ type: "change" } & WatchEvent)
  | ({ type: "invalidated" } & WatchInvalidated);

/** Successful result of starting a subscription. */
export interface WatchSubscription {
  subscriptionId: number;
  /** The requested path the consumer cares about. */
  path: string;
  /** The directory the backend actually watches (the parent for 005). */
  watchedPath: string;
  scope: WatchScope;
}

/**
 * A live subscription.
 *
 * Holding the id here (rather than at the call site) is what makes migration
 * safe: Save As / Rename stop *this* subscription instead of guessing which
 * backend watch belonged to the old path.
 */
export interface WatchSubscriptionHandle {
  readonly subscriptionId: number;
  readonly path: string;
  readonly watchedPath: string;
  readonly scope: WatchScope;
  /** Releases the subscription. Safe to call more than once. */
  stop(): Promise<void>;
}

/** Request payload of `start_filesystem_watch`. */
export interface StartWatchRequest {
  path: string;
  scope: WatchScope;
}

/** Request payload of `stop_filesystem_watch`. */
export interface StopWatchRequest {
  subscriptionId: number;
}

/** The Tauri event channel the backend emits normalized payloads on. */
export const WATCH_EVENT_NAME = "filesystem-watch-event";

/** The two watcher commands, named once so tests can pin them. */
export const START_WATCH_COMMAND = "start_filesystem_watch";
export const STOP_WATCH_COMMAND = "stop_filesystem_watch";

/**
 * The two Tauri IPC primitives this adapter needs.
 *
 * Injecting them keeps the adapter testable without a desktop shell and without
 * mocking a module, which is how the exact command names, argument shapes and
 * listener cleanup are pinned.
 */
export interface WatcherIpc {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

/** The frontend surface the opened-document coordinator depends on. */
export interface FilesystemWatcherService {
  /**
   * Starts watching `path` (non-recursively through its parent directory).
   *
   * Rejects with the Rust error contract when the path cannot be watched, which
   * the caller must treat non-destructively: a failed subscription never changes
   * a document.
   */
  subscribe(path: string, scope: WatchScope): Promise<WatchSubscriptionHandle>;
  /**
   * Subscribes to normalized payloads.
   *
   * Returns the disposer, which removes exactly this listener.
   */
  listen(listener: (payload: WatchEventPayload) => void): Promise<() => void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Whether `value` is a scope this build understands. */
export function isWatchScope(value: unknown): value is WatchScope {
  return value === "nonRecursive" || value === "recursive";
}

/** Whether `value` is a hint this build understands. */
export function isWatchChangeHint(value: unknown): value is WatchChangeHint {
  return (
    value === "created" ||
    value === "changed" ||
    value === "removed" ||
    value === "other"
  );
}

/**
 * Decodes one payload from the event channel.
 *
 * Returns `null` for anything unrecognized instead of throwing: a backend that
 * learns a new DTO must not break a running frontend, and an undecodable hint is
 * not something a document may act on.
 */
export function decodeWatchEventPayload(
  value: unknown,
): WatchEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.type === "change") {
    if (
      typeof value.subscriptionId !== "number" ||
      !isWatchScope(value.scope) ||
      typeof value.watchedPath !== "string" ||
      typeof value.path !== "string" ||
      !isWatchChangeHint(value.hint)
    ) {
      return null;
    }

    return {
      type: "change",
      subscriptionId: value.subscriptionId,
      scope: value.scope,
      watchedPath: value.watchedPath,
      path: value.path,
      hint: value.hint,
      renameTarget:
        typeof value.renameTarget === "string" ? value.renameTarget : null,
      // Both 006 fields are nullable by contract, so a missing or non-string
      // value decodes to `null` rather than failing the whole payload: an
      // undecodable *location* must not cost 005 its validation hint.
      relativePath:
        typeof value.relativePath === "string" ? value.relativePath : null,
      renameTargetRelativePath:
        typeof value.renameTargetRelativePath === "string"
          ? value.renameTargetRelativePath
          : null,
    };
  }

  if (value.type === "invalidated") {
    if (!isWatchScope(value.scope) || typeof value.reason !== "string") {
      return null;
    }

    return {
      type: "invalidated",
      scope: value.scope,
      watchedPath:
        typeof value.watchedPath === "string" ? value.watchedPath : null,
      reason: value.reason,
    };
  }

  return null;
}

/** Validates a `start_filesystem_watch` response against the contract. */
export function toWatchSubscription(value: unknown): WatchSubscription {
  if (
    !isRecord(value) ||
    typeof value.subscriptionId !== "number" ||
    typeof value.path !== "string" ||
    typeof value.watchedPath !== "string" ||
    !isWatchScope(value.scope)
  ) {
    throw new Error(
      `start_filesystem_watch returned an unexpected payload: ${JSON.stringify(value)}`,
    );
  }

  return {
    subscriptionId: value.subscriptionId,
    path: value.path,
    watchedPath: value.watchedPath,
    scope: value.scope,
  };
}

/** The real IPC boundary used by the desktop application. */
const tauriWatcherIpc: WatcherIpc = {
  invoke: <T,>(command: string, args: Record<string, unknown>) =>
    invoke<T>(command, args),
  listen: <T,>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn> => listen<T>(event, handler),
};

/** Creates a watcher adapter over an IPC boundary. */
export function createFilesystemWatcherService(
  ipc: WatcherIpc = tauriWatcherIpc,
  eventName: string = WATCH_EVENT_NAME,
): FilesystemWatcherService {
  return {
    async subscribe(
      path: string,
      scope: WatchScope,
    ): Promise<WatchSubscriptionHandle> {
      const request: StartWatchRequest = { path, scope };
      const subscription = toWatchSubscription(
        await ipc.invoke<unknown>(START_WATCH_COMMAND, { request }),
      );

      let stopped = false;

      return {
        subscriptionId: subscription.subscriptionId,
        path: subscription.path,
        watchedPath: subscription.watchedPath,
        scope: subscription.scope,
        async stop(): Promise<void> {
          if (stopped) {
            return;
          }
          stopped = true;
          const stopRequest: StopWatchRequest = {
            subscriptionId: subscription.subscriptionId,
          };
          await ipc.invoke<void>(STOP_WATCH_COMMAND, { request: stopRequest });
        },
      };
    },

    async listen(
      listener: (payload: WatchEventPayload) => void,
    ): Promise<() => void> {
      const unlisten = await ipc.listen<unknown>(eventName, (event) => {
        const payload = decodeWatchEventPayload(event.payload);
        if (payload !== null) {
          listener(payload);
        }
      });

      let disposed = false;
      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        unlisten();
      };
    },
  };
}

/** The watcher adapter the desktop application uses. */
export const tauriFilesystemWatcher: FilesystemWatcherService =
  createFilesystemWatcherService();
