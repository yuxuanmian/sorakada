import { describe, expect, it, vi } from "vitest";

import { OperationActivityCounter } from "./operationActivity";

describe("OperationActivityCounter", () => {
  it("supports nesting and idempotent release", () => {
    const activity = new OperationActivityCounter();
    const snapshots: number[] = [];
    activity.subscribe(() => {
      snapshots.push(activity.getSnapshot());
    });

    const releaseOuter = activity.begin();
    const releaseInner = activity.begin();
    expect(activity.isActive()).toBe(true);
    expect(activity.getSnapshot()).toBe(2);

    releaseInner();
    releaseInner();
    releaseOuter();
    releaseOuter();

    expect(activity.isActive()).toBe(false);
    expect(activity.getSnapshot()).toBe(0);
    expect(snapshots).toEqual([1, 2, 1, 0]);
  });

  it("releases after value, synchronous throw, and async rejection", async () => {
    const activity = new OperationActivityCounter();

    await expect(activity.run(() => 7)).resolves.toBe(7);
    expect(activity.isActive()).toBe(false);

    await expect(
      activity.run(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(activity.isActive()).toBe(false);

    await expect(
      activity.run(() => Promise.reject(new Error("async"))),
    ).rejects.toThrow("async");
    expect(activity.isActive()).toBe(false);
  });

  it("removes subscriptions without affecting the operation count", () => {
    const activity = new OperationActivityCounter();
    const listener = vi.fn();
    const unsubscribe = activity.subscribe(listener);
    unsubscribe();

    const release = activity.begin();
    release();

    expect(listener).not.toHaveBeenCalled();
    expect(activity.getSnapshot()).toBe(0);
  });
});
