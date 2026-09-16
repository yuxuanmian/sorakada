import { describe, expect, it, vi } from "vitest";

import { createCommandRegistry } from "./commandRegistry";

describe("CommandRegistry", () => {
  it("invokes exactly one handler per execute call", async () => {
    const registry = createCommandRegistry();
    const handler = vi.fn();
    registry.register("file.save", handler);

    await registry.execute("file.save");
    await registry.execute("file.save");

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("rejects a duplicate registration instead of stacking handlers", () => {
    const registry = createCommandRegistry();
    registry.register("file.new", () => {});

    expect(() => registry.register("file.new", () => {})).toThrow(
      /already registered/i,
    );
  });

  it("allows re-registration after the previous handler was unregistered", async () => {
    const registry = createCommandRegistry();
    const first = vi.fn();
    const second = vi.fn();

    const unregister = registry.register("file.open", first);
    unregister();
    registry.register("file.open", second);
    await registry.execute("file.open");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("propagates asynchronous handler failures to the caller", async () => {
    const registry = createCommandRegistry();
    const failure = new Error("disk exploded");
    registry.register("file.saveAs", async () => {
      throw failure;
    });

    await expect(registry.execute("file.saveAs")).rejects.toBe(failure);
  });

  it("propagates synchronous handler failures to the caller", async () => {
    const registry = createCommandRegistry();
    const failure = new Error("no editor");
    registry.register("editor.undo", () => {
      throw failure;
    });

    await expect(registry.execute("editor.undo")).rejects.toBe(failure);
  });

  it("reports unknown commands instead of silently doing nothing", async () => {
    const registry = createCommandRegistry();

    await expect(registry.execute("app.exit")).rejects.toThrow(
      /not registered/i,
    );
  });

  it("reports whether a command currently has a handler", () => {
    const registry = createCommandRegistry();
    const unregister = registry.register("app.exit", () => {});

    expect(registry.has("app.exit")).toBe(true);
    unregister();
    expect(registry.has("app.exit")).toBe(false);
  });
});
