import { describe, expect, it } from "vitest";

import {
  START_WATCH_COMMAND,
  STOP_WATCH_COMMAND,
  WATCH_EVENT_NAME,
  createFilesystemWatcherService,
  decodeWatchEventPayload,
  isWatchChangeHint,
  isWatchScope,
  toWatchSubscription,
  type WatcherIpc,
  type WatchEventPayload,
} from "./filesystemWatcher";
import type { FileCommandError } from "./fileService";

/**
 * Records the IPC boundary instead of mocking a module: the adapter takes its
 * `invoke`/`listen` primitives as a parameter, so the exact command names,
 * argument shapes, decoding and listener cleanup are pinned here while the Rust
 * side pins the same JSON with `serde_json` (Constitution III).
 */
class FakeWatcherIpc implements WatcherIpc {
  readonly invocations: Array<{ command: string; args: Record<string, unknown> }> =
    [];
  readonly listenCalls: Array<{
    event: string;
    handler: (event: { payload: unknown }) => void;
  }> = [];

  unlistenCount = 0;

  invokeResult: unknown = null;
  invokeError: unknown = null;
  listenError: unknown = null;

  invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    this.invocations.push({ command, args });
    if (this.invokeError !== null) {
      return Promise.reject(this.invokeError);
    }
    return Promise.resolve(this.invokeResult as T);
  }

  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> {
    this.listenCalls.push({
      event,
      handler: handler as (event: { payload: unknown }) => void,
    });
    if (this.listenError !== null) {
      return Promise.reject(this.listenError);
    }
    return Promise.resolve(() => {
      this.unlistenCount += 1;
    });
  }

  /** Delivers one raw payload as the backend would. */
  emit(payload: unknown): void {
    for (const call of this.listenCalls) {
      call.handler({ payload });
    }
  }
}

const SUBSCRIPTION = {
  subscriptionId: 7,
  path: "C:\\work\\notes.txt",
  watchedPath: "C:\\work",
  scope: "nonRecursive",
};

/** The exact `change` JSON the Rust watcher tests pin. */
const CHANGE_JSON = {
  type: "change",
  subscriptionId: 7,
  scope: "nonRecursive",
  watchedPath: "C:\\work",
  path: "C:\\work\\notes.txt",
  hint: "changed",
  renameTarget: null,
};

/** The exact `invalidated` JSON the Rust watcher tests pin. */
const INVALIDATED_JSON = {
  type: "invalidated",
  scope: "nonRecursive",
  watchedPath: "C:\\work",
  reason: "overflow",
};

describe("filesystemWatcher.subscribe", () => {
  it("invokes start_filesystem_watch with the camelCase request and returns a typed handle", async () => {
    const ipc = new FakeWatcherIpc();
    ipc.invokeResult = { ...SUBSCRIPTION };
    const watcher = createFilesystemWatcherService(ipc);

    const handle = await watcher.subscribe("C:\\work\\notes.txt", "nonRecursive");

    expect(ipc.invocations).toEqual([
      {
        command: START_WATCH_COMMAND,
        args: {
          request: { path: "C:\\work\\notes.txt", scope: "nonRecursive" },
        },
      },
    ]);
    expect(START_WATCH_COMMAND).toBe("start_filesystem_watch");
    expect(handle.subscriptionId).toBe(7);
    expect(handle.path).toBe("C:\\work\\notes.txt");
    expect(handle.watchedPath).toBe("C:\\work");
    expect(handle.scope).toBe("nonRecursive");
  });

  it("stops the subscription with its own id, exactly once", async () => {
    const ipc = new FakeWatcherIpc();
    ipc.invokeResult = { ...SUBSCRIPTION };
    const watcher = createFilesystemWatcherService(ipc);
    const handle = await watcher.subscribe("C:\\work\\notes.txt", "nonRecursive");

    await handle.stop();
    await handle.stop();

    expect(STOP_WATCH_COMMAND).toBe("stop_filesystem_watch");
    expect(ipc.invocations).toEqual([
      {
        command: START_WATCH_COMMAND,
        args: {
          request: { path: "C:\\work\\notes.txt", scope: "nonRecursive" },
        },
      },
      {
        command: STOP_WATCH_COMMAND,
        args: { request: { subscriptionId: 7 } },
      },
    ]);
  });

  it("propagates the Rust path_resolution error unchanged", async () => {
    const ipc = new FakeWatcherIpc();
    const error: FileCommandError = {
      code: "path_resolution",
      message: "Cannot resolve C:\\gone\\notes.txt",
    };
    ipc.invokeError = error;
    const watcher = createFilesystemWatcherService(ipc);

    await expect(
      watcher.subscribe("C:\\gone\\notes.txt", "nonRecursive"),
    ).rejects.toEqual(error);
  });

  it("rejects a response that does not match the subscription contract", async () => {
    const ipc = new FakeWatcherIpc();
    ipc.invokeResult = { subscriptionId: 1, path: "C:\\work\\notes.txt" };
    const watcher = createFilesystemWatcherService(ipc);

    await expect(
      watcher.subscribe("C:\\work\\notes.txt", "nonRecursive"),
    ).rejects.toThrow(/unexpected payload/);

    // A snake_case scope is a wire drift, not a payload this build may accept.
    expect(() =>
      toWatchSubscription({
        subscriptionId: 1,
        path: "a",
        watchedPath: "b",
        scope: "non_recursive",
      }),
    ).toThrow(/unexpected payload/);
  });
});

describe("filesystemWatcher.listen", () => {
  it("listens on the pinned event name and decodes a normalized change", async () => {
    const ipc = new FakeWatcherIpc();
    const watcher = createFilesystemWatcherService(ipc);
    const received: WatchEventPayload[] = [];

    await watcher.listen((payload) => {
      received.push(payload);
    });

    expect(ipc.listenCalls).toHaveLength(1);
    expect(ipc.listenCalls[0].event).toBe(WATCH_EVENT_NAME);
    expect(WATCH_EVENT_NAME).toBe("filesystem-watch-event");

    ipc.emit({ ...CHANGE_JSON });

    expect(received).toEqual([
      {
        type: "change",
        subscriptionId: 7,
        scope: "nonRecursive",
        watchedPath: "C:\\work",
        path: "C:\\work\\notes.txt",
        hint: "changed",
        renameTarget: null,
      },
    ]);
  });

  it("preserves a rename target without turning it into a document migration", async () => {
    const ipc = new FakeWatcherIpc();
    const watcher = createFilesystemWatcherService(ipc);
    const received: WatchEventPayload[] = [];
    await watcher.listen((payload) => {
      received.push(payload);
    });

    ipc.emit({ ...CHANGE_JSON, hint: "removed", renameTarget: "C:\\work\\new.txt" });

    expect(received).toEqual([
      {
        type: "change",
        subscriptionId: 7,
        scope: "nonRecursive",
        watchedPath: "C:\\work",
        path: "C:\\work\\notes.txt",
        hint: "removed",
        renameTarget: "C:\\work\\new.txt",
      },
    ]);
  });

  it("decodes invalidation so a lost event stream becomes a revalidation request", async () => {
    const ipc = new FakeWatcherIpc();
    const watcher = createFilesystemWatcherService(ipc);
    const received: WatchEventPayload[] = [];
    await watcher.listen((payload) => {
      received.push(payload);
    });

    ipc.emit({ ...INVALIDATED_JSON });

    expect(received).toEqual([
      {
        type: "invalidated",
        scope: "nonRecursive",
        watchedPath: "C:\\work",
        reason: "overflow",
      },
    ]);
  });

  it("ignores payloads that are not part of the contract", async () => {
    const ipc = new FakeWatcherIpc();
    const watcher = createFilesystemWatcherService(ipc);
    const received: WatchEventPayload[] = [];
    await watcher.listen((payload) => {
      received.push(payload);
    });

    for (const payload of [
      null,
      "text",
      42,
      { type: "unknown" },
      { type: "change" },
      { ...CHANGE_JSON, hint: "exploded" },
      { ...CHANGE_JSON, scope: "non_recursive" },
      { ...CHANGE_JSON, subscriptionId: "7" },
      { type: "invalidated", scope: "nonRecursive" },
    ]) {
      ipc.emit(payload);
    }

    expect(received).toEqual([]);
  });

  it("removes exactly this listener when the disposer runs twice", async () => {
    const ipc = new FakeWatcherIpc();
    const watcher = createFilesystemWatcherService(ipc);
    const received: WatchEventPayload[] = [];
    const dispose = await watcher.listen((payload) => {
      received.push(payload);
    });

    dispose();
    dispose();

    expect(ipc.unlistenCount).toBe(1);
  });
});

describe("decodeWatchEventPayload", () => {
  it("round-trips the JSON literals the Rust side pins", () => {
    expect(decodeWatchEventPayload({ ...CHANGE_JSON })).toEqual({
      type: "change",
      subscriptionId: 7,
      scope: "nonRecursive",
      watchedPath: "C:\\work",
      path: "C:\\work\\notes.txt",
      hint: "changed",
      renameTarget: null,
    });
    expect(decodeWatchEventPayload({ ...INVALIDATED_JSON })).toEqual({
      type: "invalidated",
      scope: "nonRecursive",
      watchedPath: "C:\\work",
      reason: "overflow",
    });
  });

  it("accepts a null watchedPath for a whole-backend invalidation", () => {
    const decoded = decodeWatchEventPayload({
      type: "invalidated",
      scope: "nonRecursive",
      watchedPath: null,
      reason: "watcher stopped",
    });

    expect(decoded).toEqual({
      type: "invalidated",
      scope: "nonRecursive",
      watchedPath: null,
      reason: "watcher stopped",
    });
  });

  it("narrows scopes and hints", () => {
    expect(isWatchScope("nonRecursive")).toBe(true);
    expect(isWatchScope("recursive")).toBe(true);
    expect(isWatchScope("NonRecursive")).toBe(false);
    expect(isWatchChangeHint("created")).toBe(true);
    expect(isWatchChangeHint("changed")).toBe(true);
    expect(isWatchChangeHint("removed")).toBe(true);
    expect(isWatchChangeHint("other")).toBe(true);
    expect(isWatchChangeHint("touched")).toBe(false);
  });
});
