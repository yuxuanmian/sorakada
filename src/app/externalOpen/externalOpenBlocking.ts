import type { OperationActivity } from "../../services/operationActivity";
import type { ExitCoordinator } from "../window/exitCoordinator";
import type { DialogManager } from "../../ui/dialog/dialogManager";

export interface ExternalOpenBlockingSources {
  dialogs: Pick<DialogManager, "isActive" | "subscribe">;
  activity: Pick<OperationActivity, "isActive" | "subscribe">;
  exit: Pick<
    ExitCoordinator,
    "isExiting" | "isExitCommitted" | "subscribe"
  >;
}

export interface ExternalOpenBlocking {
  isBlocked(): boolean;
  subscribe(listener: () => void): () => void;
}

/** Combines the three application blocks without owning their state. */
export function createExternalOpenBlocking(
  sources: ExternalOpenBlockingSources,
): ExternalOpenBlocking {
  return {
    isBlocked: () =>
      sources.dialogs.isActive() ||
      sources.activity.isActive() ||
      sources.exit.isExiting() ||
      sources.exit.isExitCommitted(),

    subscribe(listener) {
      const unsubscribeDialogs = sources.dialogs.subscribe(listener);
      const unsubscribeActivity = sources.activity.subscribe(listener);
      const unsubscribeExit = sources.exit.subscribe(listener);
      let disposed = false;

      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        unsubscribeDialogs();
        unsubscribeActivity();
        unsubscribeExit();
      };
    },
  };
}
