import { describe, expect, it } from "vitest";

import { createExternalOpenBlocking } from "./externalOpenBlocking";

function source(active: () => boolean) {
  const listeners = new Set<() => void>();
  return {
    isActive: active,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

describe("external-open blocking", () => {
  it("combines dialog, operation, exit-in-flight, and committed-exit state", () => {
    let dialog = false;
    let activity = false;
    let exiting = false;
    let committed = false;
    const dialogs = source(() => dialog);
    const operation = source(() => activity);
    const exitListeners = new Set<() => void>();
    const notifications = { value: 0 };
    const blocking = createExternalOpenBlocking({
      dialogs,
      activity: operation,
      exit: {
        isExiting: () => exiting,
        isExitCommitted: () => committed,
        subscribe(listener) {
          exitListeners.add(listener);
          return () => {
            exitListeners.delete(listener);
          };
        },
      },
    });
    const unsubscribe = blocking.subscribe(() => {
      notifications.value += 1;
    });

    expect(blocking.isBlocked()).toBe(false);

    dialog = true;
    dialogs.notify();
    expect(blocking.isBlocked()).toBe(true);
    dialog = false;

    activity = true;
    operation.notify();
    expect(blocking.isBlocked()).toBe(true);
    activity = false;

    exiting = true;
    for (const listener of exitListeners) listener();
    expect(blocking.isBlocked()).toBe(true);
    exiting = false;

    committed = true;
    for (const listener of exitListeners) listener();
    expect(blocking.isBlocked()).toBe(true);
    expect(notifications.value).toBe(4);

    unsubscribe();
    unsubscribe();
    committed = false;
    for (const listener of exitListeners) listener();
    expect(exitListeners.size).toBe(0);
  });
});
