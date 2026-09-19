import { describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";

import {
  NEW_DOCUMENT_FORMAT,
  type DocumentManagerSnapshot,
  type DocumentSession,
} from "../document/documentSession";
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
  overrides: Partial<DocumentSession> = {},
): DocumentSession {
  return {
    id: "doc-1",
    path: null,
    pathIdentity: null,
    displayName: "Untitled1",
    format: { ...NEW_DOCUMENT_FORMAT },
    dirty: false,
    savedBaseline: Text.empty,
    editorState: EditorState.create({ doc: "" }),
    viewState: { scrollTop: 0, scrollLeft: 0 },
    latestSaveGeneration: 0,
    externalState: "normal",
    bindingGeneration: 0,
    ...overrides,
  };
}

/**
 * Stands in for `DocumentManager`: title changes arrive as snapshots, and the
 * close-all decision belongs to the manager, not to this module.
 *
 * The active session is nullable, because 003 makes zero documents a valid
 * steady state (SR-002).
 */
class FakeSource implements WindowLifecycleSource {
  dirtyDocuments: DocumentSession[] = [];
  closeAllResult = true;
  closeAllCalls = 0;

  private listeners = new Set<(snapshot: DocumentManagerSnapshot) => void>();

  constructor(public activeSession: DocumentSession | null) {}

  getActiveSession(): DocumentSession | null {
    return this.activeSession;
  }

  hasDirtyDocuments(): boolean {
    return this.dirtyDocuments.length > 0;
  }

  prepareCloseAll(): Promise<boolean> {
    this.closeAllCalls += 1;
    return Promise.resolve(this.closeAllResult);
  }

  subscribe(listener: (snapshot: DocumentManagerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(session: DocumentSession | null): void {
    this.activeSession = session;
    const snapshot: DocumentManagerSnapshot = {
      activeDocumentId: session === null ? null : session.id,
      tabs: [],
    };
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Window title                                                               */
/* -------------------------------------------------------------------------- */

describe("formatWindowTitle", () => {
  it("marks only dirty documents and always names the application", () => {
    expect(formatWindowTitle(createSession())).toBe("Untitled1 - Sorakada");
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
      "*Untitled1 - Sorakada",
    );
  });

  it("never lets an inactive dirty document change the title", () => {
    const source = new FakeSource(createSession({ displayName: "Untitled2" }));
    source.dirtyDocuments = [createSession({ id: "doc-9", dirty: true })];

    expect(formatWindowTitle(source.getActiveSession())).toBe(
      "Untitled2 - Sorakada",
    );
  });

  it("names only the application while no document is open", () => {
    // FR-015/FR-016: zero documents is a real state, so the title has to
    // describe the application instead of a document that does not exist.
    expect(formatWindowTitle(null)).toBe("Sorakada");
  });
});

/* -------------------------------------------------------------------------- */
/* Zero-document title synchronisation (US4)                                   */
/* -------------------------------------------------------------------------- */

describe("installWindowLifecycle with zero documents (US4)", () => {
  it("publishes the application title on install and after the last Tab closes", async () => {
    const source = new FakeSource(
      createSession({ displayName: "Untitled1", dirty: false }),
    );
    const appWindow = new FakeWindow();

    await installWindowLifecycle(source, appWindow);
    expect(appWindow.titles).toEqual(["Untitled1 - Sorakada"]);

    // Closing the final Tab drops the active session without creating another.
    source.update(null);
    expect(appWindow.titles).toEqual([
      "Untitled1 - Sorakada",
      "Sorakada",
    ]);
  });

  it("returns to a document title when New creates the first document", async () => {
    const source = new FakeSource(null);
    const appWindow = new FakeWindow();

    await installWindowLifecycle(source, appWindow);
    expect(appWindow.titles).toEqual(["Sorakada"]);

    source.update(createSession({ displayName: "Untitled1" }));
    expect(appWindow.titles).toEqual(["Sorakada", "Untitled1 - Sorakada"]);
  });

  it("closes a zero-document window without running the unsaved guard", async () => {
    const source = new FakeSource(null);
    const appWindow = new FakeWindow();

    await installWindowLifecycle(source, appWindow);
    const event = new FakeCloseEvent();
    await appWindow.handler?.(event);

    expect(event.preventDefaultCount).toBe(0);
    expect(source.closeAllCalls).toBe(0);
    expect(appWindow.destroyCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Close interception                                                         */
/* -------------------------------------------------------------------------- */

describe("handleCloseRequested", () => {
  function createDeps(hasDirty: boolean, closeAllResult: boolean) {
    const destroyCalls: number[] = [];
    let closeAllCalls = 0;
    return {
      destroyCalls,
      closeAllCalls: () => closeAllCalls,
      deps: {
        hasDirtyDocuments: () => hasDirty,
        prepareCloseAll: async () => {
          closeAllCalls += 1;
          return closeAllResult;
        },
        destroyWindow: async () => {
          destroyCalls.push(1);
        },
      },
    };
  }

  it("lets a clean window close untouched", async () => {
    const event = new FakeCloseEvent();
    const { deps, destroyCalls, closeAllCalls } = createDeps(false, true);

    await handleCloseRequested(event, deps);

    expect(event.preventDefaultCount).toBe(0);
    expect(closeAllCalls()).toBe(0);
    expect(destroyCalls).toHaveLength(0);
  });

  it("blocks the native close, runs the guard once, then destroys", async () => {
    const event = new FakeCloseEvent();
    const { deps, destroyCalls, closeAllCalls } = createDeps(true, true);

    await handleCloseRequested(event, deps);

    expect(event.preventDefaultCount).toBe(1);
    expect(closeAllCalls()).toBe(1);
    expect(destroyCalls).toHaveLength(1);
  });

  it("keeps the window open when a document cancels the exit", async () => {
    const event = new FakeCloseEvent();
    const { deps, destroyCalls, closeAllCalls } = createDeps(true, false);

    await handleCloseRequested(event, deps);

    expect(event.preventDefaultCount).toBe(1);
    expect(closeAllCalls()).toBe(1);
    expect(destroyCalls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle installation                                                     */
/* -------------------------------------------------------------------------- */

describe("installWindowLifecycle", () => {
  it("publishes the active document's title on install and on every snapshot", async () => {
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
    source.update(createSession({ displayName: "Untitled2" }));
    expect(appWindow.titles).toHaveLength(2);
    expect(appWindow.unlistenCount).toBe(1);
  });

  it("routes a dirty close through prepareCloseAll and destroys once", async () => {
    const dirty = createSession({ dirty: true });
    const source = new FakeSource(dirty);
    source.dirtyDocuments = [dirty];
    const appWindow = new FakeWindow();

    await installWindowLifecycle(source, appWindow);

    const event = new FakeCloseEvent();
    await appWindow.handler?.(event);

    expect(event.preventDefaultCount).toBe(1);
    expect(source.closeAllCalls).toBe(1);
    expect(appWindow.destroyCount).toBe(1);
  });

  it("does not destroy the window when the manager refuses the close", async () => {
    const dirty = createSession({ dirty: true });
    const source = new FakeSource(dirty);
    source.dirtyDocuments = [dirty];
    source.closeAllResult = false;
    const appWindow = new FakeWindow();

    await installWindowLifecycle(source, appWindow);

    const event = new FakeCloseEvent();
    await appWindow.handler?.(event);

    expect(event.preventDefaultCount).toBe(1);
    expect(source.closeAllCalls).toBe(1);
    expect(appWindow.destroyCount).toBe(0);
  });

  it("does not create a replacement Tab for an approved window close", async () => {
    const dirty = createSession({ dirty: true });
    const source = new FakeSource(dirty);
    source.dirtyDocuments = [dirty];
    const appWindow = new FakeWindow();

    await installWindowLifecycle(source, appWindow);

    const before = dirty.id;
    await appWindow.handler?.(new FakeCloseEvent());

    // The lifecycle itself never closes a Tab; it only destroys the window.
    expect(source.getActiveSession()?.id).toBe(before);
    expect(appWindow.destroyCount).toBe(1);
  });
});
