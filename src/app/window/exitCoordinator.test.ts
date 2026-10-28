import { describe, expect, it, vi } from "vitest";
import { ExitCoordinator } from "./exitCoordinator";

describe("ExitCoordinator", () => {
  it("destroys window directly when no dirty documents exist", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => false,
      prepareCloseAll: vi.fn(),
      destroyWindow: destroy,
    });

    const result = await coordinator.requestExit();
    expect(result).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.isExitCommitted()).toBe(true);

    await expect(coordinator.requestExit()).resolves.toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("joins in-flight exit request without creating a second prepareCloseAll chain", async () => {
    let resolvePrepare: (value: boolean) => void = () => {};
    const prepare = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolvePrepare = r; }));
    const destroy = vi.fn().mockResolvedValue(undefined);

    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => true,
      prepareCloseAll: prepare,
      destroyWindow: destroy,
    });

    const req1 = coordinator.requestExit();
    const req2 = coordinator.requestExit();
    expect(coordinator.isExiting()).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);

    resolvePrepare(true);
    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.isExiting()).toBe(false);
    expect(coordinator.isExitCommitted()).toBe(true);
  });

  it("safely ignores exit request when modal dialog is active", async () => {
    const prepare = vi.fn();
    const destroy = vi.fn();

    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => true,
      prepareCloseAll: prepare,
      destroyWindow: destroy,
      isModalActive: () => true,
    });

    const result = await coordinator.requestExit();
    expect(result).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("cancels safely without destroying window when prepareCloseAll returns false", async () => {
    const destroy = vi.fn();
    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => true,
      prepareCloseAll: vi.fn().mockResolvedValue(false),
      destroyWindow: destroy,
    });

    const result = await coordinator.requestExit();
    expect(result).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(coordinator.isExiting()).toBe(false);
    expect(coordinator.isExitCommitted()).toBe(false);

    const result2 = await coordinator.requestExit();
    expect(result2).toBe(false);
  });

  it("handles destroyWindow rejection safely without unhandled rejection and allows retry", async () => {
    const onError = vi.fn();
    let shouldFail = true;
    const destroy = vi.fn().mockImplementation(() => {
      if (shouldFail) return Promise.reject(new Error("destroy failed"));
      return Promise.resolve();
    });
    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => false,
      prepareCloseAll: vi.fn(),
      destroyWindow: destroy,
      onError,
    });

    const result = await coordinator.requestExit();
    expect(result).toBe(false);
    expect(coordinator.isExiting()).toBe(false);
    expect(coordinator.isExitCommitted()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "window", code: "destroy_failed" }),
    );

    shouldFail = false;
    const result2 = await coordinator.requestExit();
    expect(result2).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(coordinator.isExitCommitted()).toBe(true);
  });

  it("handles synchronous throw in prepareCloseAll, reports error with window context, and allows clean retry", async () => {
    const onError = vi.fn();
    let guardCalls = 0;
    const prepare = vi.fn().mockImplementation(() => {
      guardCalls += 1;
      if (guardCalls === 1) {
        throw new Error("sync failure in guard");
      }
      return Promise.resolve(true);
    });
    const destroy = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => true,
      prepareCloseAll: prepare,
      destroyWindow: destroy,
      onError,
    });

    const snapshots: boolean[] = [];
    coordinator.subscribe(() => {
      snapshots.push(coordinator.getSnapshot());
    });

    const result1 = await coordinator.requestExit();
    expect(result1).toBe(false);
    expect(coordinator.isExiting()).toBe(false);
    expect(coordinator.isExitCommitted()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "window", code: "exit_guard_failed" }),
    );

    // Retry works cleanly without being permanently stuck in-flight
    const result2 = await coordinator.requestExit();
    expect(result2).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.isExitCommitted()).toBe(true);
  });

  it("joins in-flight exit promise even when modal is currently active for this exit", async () => {
    let modalActive = false;
    let resolvePrepare = () => {};
    const prepare = vi.fn().mockImplementation(() => {
      modalActive = true;
      return new Promise<boolean>((r) => {
        resolvePrepare = () => {
          modalActive = false;
          r(true);
        };
      });
    });

    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => true,
      prepareCloseAll: prepare,
      isModalActive: () => modalActive,
    });

    const req1 = coordinator.requestExit();
    expect(modalActive).toBe(true);

    // Second exit request arrives while exit modal is open
    const req2 = coordinator.requestExit();
    expect(prepare).toHaveBeenCalledTimes(1);

    resolvePrepare();
    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);
  });
  it("unlocks isExiting and notifies listeners when async save fails or rejects in prepareCloseAll", async () => {
    const onError = vi.fn();
    let shouldReject = true;
    const prepare = vi.fn().mockImplementation(async () => {
      if (shouldReject) {
        throw new Error("async save disk failure");
      }
      return true;
    });
    const destroy = vi.fn().mockResolvedValue(undefined);

    const coordinator = new ExitCoordinator({
      hasDirtyDocuments: () => true,
      prepareCloseAll: prepare,
      destroyWindow: destroy,
      onError,
    });

    const states: boolean[] = [];
    coordinator.subscribe(() => {
      states.push(coordinator.getSnapshot());
    });

    const result1 = await coordinator.requestExit();
    expect(result1).toBe(false);
    expect(coordinator.isExiting()).toBe(false);
    expect(coordinator.isExitCommitted()).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "window", code: "exit_guard_failed" }),
    );
    // Verified that it transitioned through true and back to false
    expect(states).toContain(true);
    expect(coordinator.getSnapshot()).toBe(false);

    // Clean retry after fixing failure
    shouldReject = false;
    const result2 = await coordinator.requestExit();
    expect(result2).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.isExiting()).toBe(false);
    expect(coordinator.isExitCommitted()).toBe(true);
  });
});
