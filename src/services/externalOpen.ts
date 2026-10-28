import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const PEEK_EXTERNAL_OPEN_REQUEST_COMMAND = "peek_external_open_request";
export const ACK_EXTERNAL_OPEN_REQUEST_COMMAND = "ack_external_open_request";
export const ACTIVATE_EXTERNAL_OPEN_MAIN_WINDOW_COMMAND =
  "activate_external_open_main_window";
export const EXTERNAL_OPEN_PENDING_EVENT = "external-open-pending";

/** One complete batch of paths delivered by the Rust single-instance intake. */
export interface ExternalOpenRequest {
  id: number;
  paths: string[];
}

/** The external-open frontend service boundary. */
export interface ExternalOpenService {
  peek(): Promise<ExternalOpenRequest | null>;
  ack(requestId: number): Promise<boolean>;
  activate(): Promise<void>;
  listen(wake: () => void): Promise<() => void>;
}

/** Injectable Tauri primitives used to pin the exact IPC boundary in tests. */
export interface ExternalOpenIpc {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Decodes the `peek_external_open_request` response or rejects a drift. */
export function toExternalOpenRequest(
  value: unknown,
): ExternalOpenRequest | null {
  if (value === null) {
    return null;
  }

  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 0 ||
    !Array.isArray(value.paths) ||
    !value.paths.every((path) => typeof path === "string")
  ) {
    throw new Error(
      `peek_external_open_request returned an unexpected payload: ${JSON.stringify(value)}`,
    );
  }

  return {
    id: value.id as number,
    paths: [...value.paths],
  };
}

/** Deduplicates settlement without hiding the adapter from its caller. */
function toDisposer(unlisten: UnlistenFn): () => void {
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unlisten();
  };
}

const tauriExternalOpenIpc: ExternalOpenIpc = {
  invoke: <T,>(command: string, args: Record<string, unknown>) =>
    invoke<T>(command, args),
  listen: <T,>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn> => listen<T>(event, handler),
};

/** Creates an adapter over the three Rust commands and the wake event. */
export function createExternalOpenService(
  ipc: ExternalOpenIpc = tauriExternalOpenIpc,
  eventName: string = EXTERNAL_OPEN_PENDING_EVENT,
): ExternalOpenService {
  return {
    async peek() {
      return toExternalOpenRequest(
        await ipc.invoke<unknown>(PEEK_EXTERNAL_OPEN_REQUEST_COMMAND, {}),
      );
    },

    async ack(requestId) {
      const result = await ipc.invoke<unknown>(
        ACK_EXTERNAL_OPEN_REQUEST_COMMAND,
        { requestId },
      );
      if (typeof result !== "boolean") {
        throw new Error(
          `ack_external_open_request returned an unexpected payload: ${JSON.stringify(result)}`,
        );
      }
      return result;
    },

    async activate() {
      const result = await ipc.invoke<unknown>(
        ACTIVATE_EXTERNAL_OPEN_MAIN_WINDOW_COMMAND,
        {},
      );
      if (result !== null) {
        throw new Error(
          `activate_external_open_main_window returned an unexpected payload: ${JSON.stringify(result)}`,
        );
      }
    },

    async listen(wake) {
      const unlisten = await ipc.listen<unknown>(eventName, () => {
        wake();
      });
      return toDisposer(unlisten);
    },
  };
}

/** The service the desktop application will inject during the next wiring phase. */
export const tauriExternalOpenService: ExternalOpenService =
  createExternalOpenService();
