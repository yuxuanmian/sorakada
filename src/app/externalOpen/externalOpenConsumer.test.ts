import { describe, expect, it, vi } from "vitest";

import type {
  OpenPathOptions,
  OpenPathResult,
} from "../document/documentManager";
import type { DocumentId } from "../document/documentSession";
import type {
  ExternalOpenRequest,
  ExternalOpenService,
} from "../../services/externalOpen";
import { ExternalOpenConsumer } from "./externalOpenConsumer";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

class FifoExternalOpenService implements ExternalOpenService {
  readonly requests: ExternalOpenRequest[] = [];
  readonly ackCalls: number[] = [];
  private readonly listeners: Array<() => void> = [];
  private readonly ackBehaviors: Array<
    "success" | "false" | "remove-then-reject"
  > = [];

  enqueue(request: ExternalOpenRequest): void {
    this.requests.push(request);
  }

  queueAckBehavior(
    behavior: "success" | "false" | "remove-then-reject",
  ): void {
    this.ackBehaviors.push(behavior);
  }

  async peek(): Promise<ExternalOpenRequest | null> {
    const request = this.requests[0];
    return request === undefined
      ? null
      : { id: request.id, paths: [...request.paths] };
  }

  async ack(requestId: number): Promise<boolean> {
    this.ackCalls.push(requestId);
    const behavior = this.ackBehaviors.shift() ?? "success";
    if (behavior === "false") {
      return false;
    }

    const matchesHead = this.requests[0]?.id === requestId;
    if (matchesHead) {
      this.requests.shift();
    }

    if (behavior === "remove-then-reject") {
      throw new Error("ack IPC response was lost");
    }
    return matchesHead;
  }

  async activate(): Promise<void> {}

  async listen(wake: () => void): Promise<() => void> {
    this.listeners.push(wake);
    return () => {
      const index = this.listeners.indexOf(wake);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  emitWake(): void {
    for (const wake of [...this.listeners]) {
      wake();
    }
  }
}

function setup(serviceOverride?: ExternalOpenService) {
  const listeners: Array<() => void> = [];
  let unlistenCount = 0;
  let blocked = false;

  const listen = vi.fn(async (wake: () => void): Promise<() => void> => {
    listeners.push(wake);
    return () => {
      unlistenCount += 1;
    };
  });
  const peek = vi.fn(
    async (): Promise<ExternalOpenRequest | null> => null,
  );
  const ack = vi.fn(async (_requestId: number): Promise<boolean> => true);
  const activate = vi.fn(async (): Promise<void> => undefined);
  const openPath = vi.fn(
    async (
      _path: string,
      _options?: OpenPathOptions,
    ): Promise<OpenPathResult> => ({ status: "cancelled" }),
  );
  const activateDocument = vi.fn((_id: DocumentId): void => undefined);
  const errors: unknown[] = [];

  const service: ExternalOpenService = serviceOverride ?? {
    listen,
    peek,
    ack,
    activate,
  };
  const consumer = new ExternalOpenConsumer({
    service,
    documents: { openPath, activateDocument },
    isBlocked: () => blocked,
    onError: (error) => {
      errors.push(error);
    },
  });

  return {
    consumer,
    listen,
    peek,
    ack,
    activate,
    openPath,
    activateDocument,
    errors,
    setBlocked(value: boolean) {
      blocked = value;
    },
    emitWake() {
      listeners[listeners.length - 1]?.();
    },
    get unlistenCount() {
      return unlistenCount;
    },
  };
}

const REQUEST_A: ExternalOpenRequest = {
  id: 1,
  paths: ["C:\\work\\a.txt", "C:\\work\\b.txt"],
};

describe("ExternalOpenConsumer", () => {
  it("installs the listener before peeking and retries after a wake during peek", async () => {
    const harness = setup();
    const firstPeek = deferred<ExternalOpenRequest | null>();
    harness.peek.mockReturnValueOnce(firstPeek.promise);

    await harness.consumer.start();
    await flush();

    expect(harness.listen).toHaveBeenCalledTimes(1);
    expect(harness.peek).toHaveBeenCalledTimes(1);
    expect(
      harness.listen.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.peek.mock.invocationCallOrder[0] ?? 0);

    harness.emitWake();
    firstPeek.resolve(null);
    await flush();

    expect(harness.peek).toHaveBeenCalledTimes(2);
    harness.consumer.stop();
  });

  it("processes paths sequentially, tolerates item failures, and activates the last success", async () => {
    const harness = setup();
    const request: ExternalOpenRequest = {
      id: 12,
      paths: [
        "opened",
        "throws",
        "cancelled",
        "directory",
        "failed",
        "existing",
      ],
    };
    harness.peek.mockResolvedValueOnce(request).mockResolvedValue(null);

    const trace: string[] = [];
    harness.activate.mockRejectedValueOnce(
      new Error("activation IPC failed"),
    );
    harness.openPath.mockImplementation(async (path, options) => {
      trace.push(`open:${path}:${options?.ignoreDirectories === true}`);
      if (path === "opened") {
        return { status: "opened", documentId: "doc-open" };
      }
      if (path === "throws") {
        throw new Error("unexpected open failure");
      }
      if (path === "cancelled") {
        return { status: "cancelled" };
      }
      if (path === "directory") {
        return { status: "ignored-directory" };
      }
      if (path === "failed") {
        return {
          status: "failed",
          error: { code: "unsupported_binary", message: "binary" },
        };
      }
      return { status: "activated-existing", documentId: "doc-existing" };
    });
    harness.activateDocument.mockImplementation((id) => {
      trace.push(`activate-document:${id}`);
    });
    harness.ack.mockImplementation(async (requestId) => {
      trace.push(`ack:${requestId}`);
      return true;
    });

    await harness.consumer.start();
    await flush();

    expect(trace).toEqual([
      "open:opened:true",
      "open:throws:true",
      "open:cancelled:true",
      "open:directory:true",
      "open:failed:true",
      "open:existing:true",
      "activate-document:doc-existing",
      "ack:12",
    ]);
    expect(harness.errors).toHaveLength(2);
    expect(
      harness.errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual(["activation IPC failed", "unexpected open failure"]);
    harness.consumer.stop();
  });

  it("activates and acknowledges an empty batch without touching documents", async () => {
    const harness = setup();
    harness.peek
      .mockResolvedValueOnce({ id: 20, paths: [] })
      .mockResolvedValue(null);

    await harness.consumer.start();
    await flush();

    expect(harness.activate).toHaveBeenCalledTimes(1);
    expect(harness.openPath).not.toHaveBeenCalled();
    expect(harness.activateDocument).not.toHaveBeenCalled();
    expect(harness.ack).toHaveBeenCalledWith(20);
    expect(harness.errors).toEqual([]);
    harness.consumer.stop();
  });

  it("rechecks blocking before each path and resumes on notify", async () => {
    const harness = setup();
    harness.peek
      .mockResolvedValueOnce(REQUEST_A)
      .mockResolvedValue(null);
    harness.openPath.mockImplementation(async (path) => {
      if (path.endsWith("a.txt")) {
        harness.setBlocked(true);
        return { status: "opened", documentId: "doc-a" };
      }
      return { status: "opened", documentId: "doc-b" };
    });

    await harness.consumer.start();
    await flush();

    expect(harness.openPath.mock.calls.map(([path]) => path)).toEqual([
      "C:\\work\\a.txt",
    ]);
    expect(harness.ack).not.toHaveBeenCalled();

    harness.setBlocked(false);
    harness.consumer.notifyCanProcess();
    await flush();

    expect(harness.openPath.mock.calls.map(([path]) => path)).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\b.txt",
    ]);
    expect(harness.ack).toHaveBeenCalledWith(1);
    harness.consumer.stop();
  });

  it("resumes after stop/start during an open without replaying that file", async () => {
    const harness = setup();
    const firstOpen = deferred<OpenPathResult>();
    harness.peek
      .mockResolvedValueOnce(REQUEST_A)
      .mockResolvedValue(null);
    harness.openPath.mockImplementation(async (path) => {
      if (path.endsWith("a.txt")) {
        return firstOpen.promise;
      }
      return { status: "opened", documentId: "doc-b" };
    });

    await harness.consumer.start();
    await flush();
    expect(harness.openPath).toHaveBeenCalledTimes(1);

    harness.consumer.stop();
    await harness.consumer.start();
    await flush();
    expect(harness.openPath).toHaveBeenCalledTimes(1);

    firstOpen.resolve({ status: "opened", documentId: "doc-a" });
    await flush();

    expect(harness.openPath.mock.calls.map(([path]) => path)).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\b.txt",
    ]);
    expect(harness.activateDocument).toHaveBeenCalledWith("doc-b");
    expect(harness.ack).toHaveBeenCalledTimes(1);
    harness.consumer.stop();
  });

  it("resumes after stop/start during a peek without losing the queued request", async () => {
    const harness = setup();
    const firstPeek = deferred<ExternalOpenRequest | null>();
    harness.peek
      .mockReturnValueOnce(firstPeek.promise)
      .mockResolvedValueOnce({ id: 31, paths: ["after-restart"] })
      .mockResolvedValue(null);
    harness.openPath.mockResolvedValue({
      status: "opened",
      documentId: "doc-after-restart",
    });

    await harness.consumer.start();
    await flush();
    expect(harness.peek).toHaveBeenCalledTimes(1);

    harness.consumer.stop();
    await harness.consumer.start();
    await flush();
    expect(harness.peek).toHaveBeenCalledTimes(1);

    firstPeek.resolve(null);
    await flush();

    expect(harness.peek).toHaveBeenCalledTimes(3);
    expect(harness.openPath).toHaveBeenCalledWith("after-restart", {
      ignoreDirectories: true,
    });
    expect(harness.ack).toHaveBeenCalledWith(31);
    harness.consumer.stop();
  });

  it("disposes a listener whose asynchronous installation finishes after stop", async () => {
    const harness = setup();
    const pendingListener = deferred<() => void>();
    const staleDispose = vi.fn();
    harness.listen.mockReturnValueOnce(pendingListener.promise);

    const starting = harness.consumer.start();
    harness.consumer.stop();
    pendingListener.resolve(staleDispose);
    await starting;
    await flush();

    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(harness.peek).not.toHaveBeenCalled();
    expect(harness.unlistenCount).toBe(0);
  });

  it("keeps a processed request pending after ack failure and retries without reopening", async () => {
    const service = new FifoExternalOpenService();
    service.enqueue({ id: 44, paths: ["only.txt"] });
    service.queueAckBehavior("false");
    service.queueAckBehavior("success");
    const harness = setup(service);
    harness.openPath.mockResolvedValue({
      status: "opened",
      documentId: "doc-only",
    });

    await harness.consumer.start();
    await flush();

    expect(harness.openPath).toHaveBeenCalledTimes(1);
    expect(service.ackCalls).toEqual([44]);
    expect(harness.errors).toHaveLength(1);

    service.emitWake();
    await flush();

    expect(harness.openPath).toHaveBeenCalledTimes(1);
    expect(harness.activateDocument).toHaveBeenCalledTimes(1);
    expect(service.ackCalls).toEqual([44, 44]);
    harness.consumer.stop();
  });

  it("reconciles a lost ack response and opens the next FIFO batch without replaying", async () => {
    const service = new FifoExternalOpenService();
    service.enqueue({ id: 61, paths: ["first.txt"] });
    service.enqueue({ id: 62, paths: ["second.txt"] });
    service.queueAckBehavior("remove-then-reject");
    service.queueAckBehavior("false");
    const harness = setup(service);
    harness.openPath.mockImplementation(async (path) => ({
      status: "opened",
      documentId: path === "first.txt" ? "doc-first" : "doc-second",
    }));

    await harness.consumer.start();
    await flush();

    expect(harness.openPath.mock.calls.map(([path]) => path)).toEqual([
      "first.txt",
    ]);
    expect(service.ackCalls).toEqual([61]);
    expect(harness.errors).toHaveLength(1);

    service.emitWake();
    await flush();

    expect(harness.openPath.mock.calls.map(([path]) => path)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(harness.activateDocument).toHaveBeenLastCalledWith("doc-second");
    expect(service.ackCalls).toEqual([61, 61, 62]);
    expect(service.requests).toEqual([]);
    harness.consumer.stop();
  });

  it("clears an acknowledged head after stop/start without reopening it", async () => {
    const harness = setup();
    const pendingAck = deferred<boolean>();
    harness.peek
      .mockResolvedValueOnce({ id: 55, paths: ["ack-race.txt"] })
      .mockResolvedValue(null);
    harness.ack.mockReturnValueOnce(pendingAck.promise);
    harness.openPath.mockResolvedValue({
      status: "opened",
      documentId: "doc-ack-race",
    });

    await harness.consumer.start();
    await flush();
    expect(harness.ack).toHaveBeenCalledTimes(1);

    harness.consumer.stop();
    await harness.consumer.start();
    await flush();
    expect(harness.openPath).toHaveBeenCalledTimes(1);

    pendingAck.resolve(true);
    await flush();

    expect(harness.openPath).toHaveBeenCalledTimes(1);
    expect(harness.ack).toHaveBeenCalledTimes(1);
    harness.consumer.stop();
  });
});
