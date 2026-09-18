import { describe, expect, it, vi } from "vitest";

import { createCommandRegistry } from "./commandRegistry";
import { COMMAND_IDS, type CommandId } from "./commandIds";

/** Registers a command the way the application does. */
function register(
  registry: ReturnType<typeof createCommandRegistry>,
  id: CommandId,
  execute: () => void | Promise<void>,
  isEnabled?: () => boolean,
): () => void {
  return registry.register(id, isEnabled === undefined ? { execute } : { execute, isEnabled });
}

describe("CommandRegistry registration and execution", () => {
  it("invokes exactly one handler per execute call", async () => {
    const registry = createCommandRegistry();
    const handler = vi.fn();
    register(registry, "file.save", handler);

    await registry.execute("file.save");
    await registry.execute("file.save");

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("rejects a duplicate registration instead of stacking handlers", () => {
    const registry = createCommandRegistry();
    register(registry, "file.new", () => {});

    expect(() => register(registry, "file.new", () => {})).toThrow(
      /already registered/i,
    );
  });

  it("allows re-registration after the previous handler was unregistered", async () => {
    const registry = createCommandRegistry();
    const first = vi.fn();
    const second = vi.fn();

    const unregister = register(registry, "file.open", first);
    unregister();
    register(registry, "file.open", second);
    await registry.execute("file.open");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("propagates asynchronous handler failures to the caller", async () => {
    const registry = createCommandRegistry();
    const failure = new Error("disk exploded");
    register(registry, "file.saveAs", async () => {
      throw failure;
    });

    await expect(registry.execute("file.saveAs")).rejects.toBe(failure);
  });

  it("propagates synchronous handler failures to the caller", async () => {
    const registry = createCommandRegistry();
    const failure = new Error("no editor");
    register(registry, "editor.undo", () => {
      throw failure;
    });

    await expect(registry.execute("editor.undo")).rejects.toBe(failure);
  });

  it("reports whether a command currently has a handler", () => {
    const registry = createCommandRegistry();
    const unregister = register(registry, "app.exit", () => {});

    expect(registry.has("app.exit")).toBe(true);
    unregister();
    expect(registry.has("app.exit")).toBe(false);
  });
});

describe("CommandRegistry availability (FR-019..FR-022)", () => {
  it("treats a registration without isEnabled as enabled", async () => {
    const registry = createCommandRegistry();
    const handler = vi.fn();
    register(registry, "file.new", handler);

    expect(registry.isEnabled("file.new")).toBe(true);
    await registry.execute("file.new");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reports an unregistered command as unavailable and still rejects execution", async () => {
    const registry = createCommandRegistry();

    expect(registry.isEnabled("view.toggleExplorer")).toBe(false);
    expect(registry.has("view.toggleExplorer")).toBe(false);
    await expect(registry.execute("view.toggleExplorer")).rejects.toThrow(
      /not registered/i,
    );
  });

  it("evaluates the predicate live instead of caching the first answer", () => {
    const registry = createCommandRegistry();
    let active = false;
    register(
      registry,
      "file.save",
      () => {},
      () => active,
    );

    expect(registry.isEnabled("file.save")).toBe(false);
    active = true;
    expect(registry.isEnabled("file.save")).toBe(true);
    active = false;
    expect(registry.isEnabled("file.save")).toBe(false);
  });

  it("does not call the handler of a disabled command", async () => {
    const registry = createCommandRegistry();
    const handler = vi.fn();
    register(
      registry,
      "file.save",
      handler,
      () => false,
    );

    // Resolving without throwing is what lets a recognized shortcut be
    // consumed without leaking into another action (FR-022).
    await expect(registry.execute("file.save")).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("re-checks availability at execution time", async () => {
    const registry = createCommandRegistry();
    const handler = vi.fn();
    let enabled = false;
    register(
      registry,
      "editor.redo",
      handler,
      () => enabled,
    );

    await registry.execute("editor.redo");
    expect(handler).not.toHaveBeenCalled();

    enabled = true;
    await registry.execute("editor.redo");
    expect(handler).toHaveBeenCalledTimes(1);

    enabled = false;
    await registry.execute("editor.redo");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps a disabled command from failing the caller", async () => {
    const registry = createCommandRegistry();
    register(registry, "file.close", () => {
      throw new Error("must not run");
    }, () => false);

    await expect(registry.execute("file.close")).resolves.toBeUndefined();
  });
});

describe("CommandRegistry 003 command identities", () => {
  it("carries every Workspace, Explorer and shell command id", () => {
    const expected: CommandId[] = [
      "workspace.openFolder",
      "workspace.closeFolder",
      "explorer.newFile",
      "explorer.newFolder",
      "explorer.rename",
      "explorer.delete",
      "explorer.refresh",
      "view.toggleExplorer",
    ];

    for (const id of expected) {
      expect(COMMAND_IDS).toContain(id);
    }
  });

  it("gives every surface one availability decision per command", async () => {
    const registry = createCommandRegistry();
    const handler = vi.fn();
    let workspace = null as string | null;

    register(
      registry,
      "workspace.closeFolder",
      handler,
      () => workspace !== null,
    );

    // The menu, a context menu and a shortcut all ask this same predicate.
    expect(registry.isEnabled("workspace.closeFolder")).toBe(false);
    await registry.execute("workspace.closeFolder");
    expect(handler).not.toHaveBeenCalled();

    workspace = "C:\\work";
    expect(registry.isEnabled("workspace.closeFolder")).toBe(true);
    await registry.execute("workspace.closeFolder");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps Explorer Rename/Delete unavailable without a target and available with one", async () => {
    const registry = createCommandRegistry();
    const rename = vi.fn();
    const remove = vi.fn();
    let selectedPath: string | null = "C:\\work\\notes.txt";

    register(registry, "explorer.rename", rename, () => selectedPath !== null);
    register(registry, "explorer.delete", remove, () => selectedPath !== null);

    await registry.execute("explorer.rename");
    expect(rename).toHaveBeenCalledTimes(1);

    selectedPath = null;
    await registry.execute("explorer.rename");
    await registry.execute("explorer.delete");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
