import { describe, expect, it } from "vitest";
import { DialogManager } from "./dialogManager";

describe("DialogManager", () => {
  it("rejects immediately if no host is attached", async () => {
    const manager = new DialogManager();
    const result = await manager.request({
      title: () => "Test",
      message: () => "Msg",
      buttons: [{ value: "ok", label: () => "OK" }],
      cancelValue: "cancel",
    });
    expect(result).toBe("cancel");
    expect(manager.getSnapshot()).toBeNull();
  });

  it("queues requests serially and activates next in microtask", async () => {
    const manager = new DialogManager();
    const detach = manager.attach();

    const p1 = manager.request({
      title: () => "D1",
      message: () => "Msg1",
      buttons: [{ value: "yes", label: () => "Yes" }, { value: "cancel", label: () => "Cancel" }],
      cancelValue: "cancel",
    });

    const p2 = manager.request({
      title: () => "D2",
      message: () => "Msg2",
      buttons: [{ value: "ok", label: () => "OK" }, { value: "cancel", label: () => "Cancel" }],
      cancelValue: "cancel",
    });

    expect(manager.getSnapshot()?.title()).toBe("D1");

    // Close D1
    manager.choose(manager.getSnapshot()!.id, "yes");

    // D2 is not active in the exact same synchronous turn
    expect(manager.getSnapshot()).toBeNull();

    // After microtask, D2 activates
    await Promise.resolve();
    expect(manager.getSnapshot()?.title()).toBe("D2");
    await expect(p1).resolves.toBe("yes");

    manager.choose(manager.getSnapshot()!.id, "ok");
    await expect(p2).resolves.toBe("ok");

    detach();
  });

  it("cancels all active and queued requests on host detach without hanging", async () => {
    const manager = new DialogManager();
    const detach = manager.attach();

    const p1 = manager.request({
      title: () => "D1",
      message: () => "Msg1",
      buttons: [{ value: "ok", label: () => "OK" }],
      cancelValue: "cancel-1",
    });
    const p2 = manager.request({
      title: () => "D2",
      message: () => "Msg2",
      buttons: [{ value: "ok", label: () => "OK" }],
      cancelValue: "cancel-2",
    });

    detach();

    await expect(p1).resolves.toBe("cancel-1");
    await expect(p2).resolves.toBe("cancel-2");
    expect(manager.getSnapshot()).toBeNull();
    expect(manager.isActive()).toBe(false);
  });

  it("skips queued request if invalid before display", async () => {
    const manager = new DialogManager();
    const detach = manager.attach();

    let d2Valid = true;
    const p1 = manager.request({
      title: () => "D1",
      message: () => "Msg1",
      buttons: [{ value: "ok", label: () => "OK" }],
      cancelValue: "cancel",
    });
    const p2 = manager.request({
      title: () => "D2",
      message: () => "Msg2",
      buttons: [{ value: "ok", label: () => "OK" }],
      cancelValue: "cancel-2",
      validity: { isValid: () => d2Valid },
    });
    const p3 = manager.request({
      title: () => "D3",
      message: () => "Msg3",
      buttons: [{ value: "ok", label: () => "OK" }],
      cancelValue: "cancel-3",
    });

    d2Valid = false;
    manager.choose(manager.getSnapshot()!.id, "ok");
    await expect(p1).resolves.toBe("ok");
    await expect(p2).resolves.toBe("cancel-2");

    await Promise.resolve();
    expect(manager.getSnapshot()?.title()).toBe("D3");
    manager.choose(manager.getSnapshot()!.id, "ok");
    await expect(p3).resolves.toBe("ok");

    detach();
  });

  it("resolves cancelValue if active request becomes invalid before choice resolves", async () => {
    const manager = new DialogManager();
    const detach = manager.attach();

    let valid = true;
    const p = manager.request({
      title: () => "D1",
      message: () => "Msg1",
      buttons: [{ value: "destructive", label: () => "Delete" }, { value: "cancel", label: () => "Cancel" }],
      cancelValue: "cancel",
      validity: { isValid: () => valid },
    });

    // File was deleted on disk or state changed while dialog was showing
    valid = false;
    manager.choose(manager.getSnapshot()!.id, "destructive");
    await expect(p).resolves.toBe("cancel");

    detach();
  });
});
