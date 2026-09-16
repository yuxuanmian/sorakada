import { describe, expect, it } from "vitest";

import type { ActiveDocumentSession } from "../document/documentSession";
import {
  formatWindowTitle,
  handleCloseRequested,
  installWindowLifecycle,
  type AppWindowLike,
  type CloseRequestedLike,
  type WindowLifecycleSource,
} from "./windowLifecycle";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

class FakeWindow implements AppWindowLike {
  readonly titles: string[] = [];
  destroyCount = 0;
  unlistenCount = 0;
  handler: ((event: CloseRequestedLike) => void | Promise<void>) | null = null;

  async setTitle(title: string): Promise<void> {
    this.titles.push(title);
  }

  async destroy(): Promise<void> {
    this.destroyCount += 1;
  }

  async onCloseRequested(
    handler: (event: CloseRequestedLike) => void | Promise<void>,
  ): Promise<() => void> {
    this.handler = handler;
    return () => {
      this.unlistenCount += 1;
    };
  }
}

class FakeCloseEvent implements CloseRequestedLike {
  preventDefaultCount = 0;

  preventDefault(): void {
    this.preventDefaultCount += 1;
  }
}

function createSession(
  overrides: Partial<ActiveDocumentSession> = {},
): ActiveDocumentSession {
  return {
    path: null,
    displayName: "Untitled",
    format: {
      encoding: "utf8",
      bom: "none",
      detectedLineEnding: "none",
      preferredLineEnding: "crlf",
    },
    dirty: false,
    ...overrides,
  };
}

class FakeSource implements WindowLifecycleSource {
  guardResult = true;
  guardCalls = 0;
  private listeners = new Set<(session: ActiveDocumentSession) => void>();

  constructor(public session: ActiveDocumentSession) {}

  getSession(): ActiveDocumentSession {
    return this.session;
  }

  subscribe(listener: (session: ActiveDocumentSession) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async runUnsavedGuard(): Promise<boolean> {
    this.guardCalls += 1;
    return this.guardResult;
  }

  update(session: ActiveDocumentSession): void {
    this.session = session;
    for (const listener of this.listeners) {
      listener(session);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Window title                                                               */
/* -------------------------------------------------------------------------- */

describe("formatWindowTitle", () => {
  it("marks only dirty documents and always names the application", () => {
    expect(formatWindowTitle(createSession())).toBe("Untitled - Sorakada");
    expect(
      formatWindowTitle(
        createSession({ path: "C:\\w\\foo.txt", displayName: "foo.txt" }),
      ),
    ).toBe("foo.txt - Sorakada");
    expect(
      formatWindowTitle(
        createSession({
          path: "C:\\w\\foo.txt",
          displayName: "foo.txt",
          dirty: true,
        }),
      ),
    ).toBe("*foo.txt - Sorakada");
    expect(formatWindowTitle(createSession({ dirty: true }))).toBe(
      "*Untitled - Sorakada",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Close interception                                                         */
/* -------------------------------------------------------------------------- */

describe("handleCloseRequested", () => {
  function createDeps(dirty: boolean, guardResult: boolean) {
    const destroyCalls: number[] = [];
    return {
      destroyCalls,
      deps: {
        isDocumentDirty: () => dirty,
        runUnsavedGuard: async () => guardResult,
        destroyWindow: async () => {
          destroyCalls.push(1);
        },
      },
    };
  }

  it("lets a clean document close without a prompt or a forced destroy", async () => {
    const event = new FakeCloseEvent();
    const { deps, destroyCalls } = createDeps(false, true);

    await handleCloseRequested(event, deps);

    expect(event.preventDefaultCount).toBe(0);
    expect(destroyCalls).toHaveLength(0);
  });

  it("blocks a dirty close, then forces the destroy after an approved guard", async () => {
    const event = new FakeCloseEvent();
    const { deps, destroyCalls } = createDeps(true, true);

    await handleCloseRequested(event, deps);

    expect(event.preventDefaultCount).toBe(1);
    expect(destroyCalls).toHaveLength(1);
  });

  it("blocks a dirty close and keeps the window when the guard is cancelled", async () => {
    const event = new FakeCloseEvent();
    const { deps, destroyCalls } = createDeps(true, false);

    await handleCloseRequested(event, deps);

    expect(event.preventDefaultCount).toBe(1);
    expect(destroyCalls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle installation                                                     */
/* -------------------------------------------------------------------------- */

describe("installWindowLifecycle", () => {
  it("publishes the current title on install and on every session change", async () => {
    const source = new FakeSource(
      createSession({ path: "C:\\w\\foo.txt", displayName: "foo.txt" }),
    );
    const appWindow = new FakeWindow();

    const dispose = await installWindowLifecycle(source, appWindow);
    expect(appWindow.titles).toEqual(["foo.txt - Sorakada"]);

    source.update(
      createSession({
        path: "C:\\w\\foo.txt",
        displayName: "foo.txt",
        dirty: true,
      }),
    );
    expect(appWindow.titles).toEqual([
      "foo.txt - Sorakada",
      "*foo.txt - Sorakada",
    ]);

    dispose();
    source.update(createSession());
    expect(appWindow.titles).toHaveLength(2);
    expect(appWindow.unlistenCount).toBe(1);
  });

  it("routes a dirty close through the shared unsaved guard and destroys once", async () => {
    const source = new FakeSource(createSession({ dirty: true }));
    const appWindow = new FakeWindow();
    source.guardResult = true;

    await installWindowLifecycle(source, appWindow);

    const event = new FakeCloseEvent();
    await appWindow.handler?.(event);

    expect(event.preventDefaultCount).toBe(1);
    expect(source.guardCalls).toBe(1);
    expect(appWindow.destroyCount).toBe(1);
  });

  it("does not destroy the window when the guard cancels the exit", async () => {
    const source = new FakeSource(createSession({ dirty: true }));
    const appWindow = new FakeWindow();
    source.guardResult = false;

    await installWindowLifecycle(source, appWindow);

    const event = new FakeCloseEvent();
    await appWindow.handler?.(event);

    expect(event.preventDefaultCount).toBe(1);
    expect(appWindow.destroyCount).toBe(0);
  });
});
