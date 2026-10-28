import { describe, expect, it } from "vitest";

import {
  ACK_EXTERNAL_OPEN_REQUEST_COMMAND,
  ACTIVATE_EXTERNAL_OPEN_MAIN_WINDOW_COMMAND,
  EXTERNAL_OPEN_PENDING_EVENT,
  PEEK_EXTERNAL_OPEN_REQUEST_COMMAND,
  createExternalOpenService,
  type ExternalOpenIpc,
} from "./externalOpen";

class FakeExternalOpenIpc implements ExternalOpenIpc {
  readonly invocations: Array<{
    command: string;
    args: Record<string, unknown>;
  }> = [];
  readonly listenCalls: Array<{
    event: string;
    handler: (event: { payload: unknown }) => void;
  }> = [];

  readonly invokeResults: unknown[] = [];
  unlistenCount = 0;

  invoke<T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    this.invocations.push({ command, args });
    return Promise.resolve(this.invokeResults.shift() as T);
  }

  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> {
    this.listenCalls.push({
      event,
      handler: handler as (event: { payload: unknown }) => void,
    });
    return Promise.resolve(() => {
      this.unlistenCount += 1;
    });
  }
}

describe("externalOpen service", () => {
  it("pins the peek command and returns the exact request or null", async () => {
    const ipc = new FakeExternalOpenIpc();
    ipc.invokeResults.push(
      {
        id: 9,
        paths: ["C:\\目录\\file one.txt", "\\\\server\\share\\two.md"],
      },
      null,
    );
    const service = createExternalOpenService(ipc);

    await expect(service.peek()).resolves.toEqual({
      id: 9,
      paths: ["C:\\目录\\file one.txt", "\\\\server\\share\\two.md"],
    });
    await expect(service.peek()).resolves.toBeNull();

    expect(PEEK_EXTERNAL_OPEN_REQUEST_COMMAND).toBe(
      "peek_external_open_request",
    );
    expect(ipc.invocations).toEqual([
      { command: "peek_external_open_request", args: {} },
      { command: "peek_external_open_request", args: {} },
    ]);
  });

  it("rejects malformed peek data instead of inventing queue state", async () => {
    const ipc = new FakeExternalOpenIpc();
    ipc.invokeResults.push({ id: 1, paths: [42] });
    const service = createExternalOpenService(ipc);

    await expect(service.peek()).rejects.toThrow(
      "returned an unexpected payload",
    );
  });

  it("pins ack and activation argument shapes and return contracts", async () => {
    const ipc = new FakeExternalOpenIpc();
    ipc.invokeResults.push(true, null);
    const service = createExternalOpenService(ipc);

    await expect(service.ack(17)).resolves.toBe(true);
    await expect(service.activate()).resolves.toBeUndefined();

    expect(ACK_EXTERNAL_OPEN_REQUEST_COMMAND).toBe(
      "ack_external_open_request",
    );
    expect(ACTIVATE_EXTERNAL_OPEN_MAIN_WINDOW_COMMAND).toBe(
      "activate_external_open_main_window",
    );
    expect(ipc.invocations).toEqual([
      { command: "ack_external_open_request", args: { requestId: 17 } },
      { command: "activate_external_open_main_window", args: {} },
    ]);
  });

  it("listens only to the fixed wake event and disposes once", async () => {
    const ipc = new FakeExternalOpenIpc();
    const service = createExternalOpenService(ipc);
    let wakeCount = 0;

    const dispose = await service.listen(() => {
      wakeCount += 1;
    });
    ipc.listenCalls[0]?.handler({ payload: null });
    dispose();
    dispose();

    expect(EXTERNAL_OPEN_PENDING_EVENT).toBe("external-open-pending");
    expect(ipc.listenCalls).toHaveLength(1);
    expect(ipc.listenCalls[0]?.event).toBe("external-open-pending");
    expect(wakeCount).toBe(1);
    expect(ipc.unlistenCount).toBe(1);
  });
});
