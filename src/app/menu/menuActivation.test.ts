/**
 * T075: one menu activation executes a command at most once.
 *
 * The registry already guarantees that one `execute()` calls its handler once.
 * What this pins is the layer above it: the menu's activation path must resolve to
 * exactly *one* command id — never two, and never a command for a purely local
 * entry.
 */

import { describe, expect, it, vi } from "vitest";

import type { CommandId } from "../commands/commandIds";
import { createCommandRegistry } from "../commands/commandRegistry";
import { allMenuItems } from "../../ui/menu/menuModel";
import { buildAppMenuModel } from "./appMenuModel";
import { activateMenuItem } from "./menuActivation";
import { buildExplorerMenuModel } from "../explorer/explorerMenuModel";
import { deriveFileOperationContext } from "../explorer/explorerActions";
import type { WorkContext } from "../workspace/workContext";

const workContext: WorkContext = {
  id: "workspace-1",
  rootPath: "C:\\work",
  canonicalRootPath: "c:\\work",
  comparisonKey: "c:\\work",
  displayName: "work",
};

describe("activateMenuItem", () => {
  it("dispatches exactly one command for a command-backed item", () => {
    const dispatch = vi.fn();
    const dispatched = activateMenuItem(
      { id: "new", label: "New", commandId: "file.new" },
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("file.new");
    expect(dispatched).toBe("file.new");
  });

  it("dispatches nothing for a local item", () => {
    const dispatch = vi.fn();
    expect(activateMenuItem({ id: "local", label: "Local" }, dispatch)).toBe(
      undefined,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("cannot dispatch twice for one activation", () => {
    let count = 0;
    activateMenuItem({ id: "save", label: "Save", commandId: "file.save" }, () => {
      count += 1;
    });
    expect(count).toBe(1);
  });
});

describe("menu models offer one activation path per entry", () => {
  it("App Menu: every command-backed item dispatches once", () => {
    const model = buildAppMenuModel({
      isEnabled: () => true,
      developer: true,
    });

    for (const item of allMenuItems(model)) {
      const dispatch = vi.fn();
      activateMenuItem(item, dispatch);
      expect(dispatch, item.id).toHaveBeenCalledTimes(1);
      expect(dispatch, item.id).toHaveBeenCalledWith(item.commandId);
    }
  });

  it("App Menu: no two entries dispatch the same command", () => {
    const model = buildAppMenuModel({
      isEnabled: () => true,
      developer: true,
    });
    const commands = allMenuItems(model).map((item) => item.commandId);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("Explorer menu: a disabled entry is still refused by the registry", async () => {
    const registry = createCommandRegistry();
    const handler = vi.fn();
    let enabled = false;
    registry.register("explorer.delete", {
      execute: handler,
      isEnabled: () => enabled,
    });

    const model = buildExplorerMenuModel(
      deriveFileOperationContext(workContext, {
        name: "a.ts",
        path: "C:\\work\\a.ts",
        kind: "file",
        isSymlink: false,
        objectIdentity: null,
      }),
      { isEnabled: (id) => registry.isEnabled(id) },
    );

    const deleteItem = allMenuItems(model).find(
      (item) => item.commandId === "explorer.delete",
    );
    expect(deleteItem?.disabled).toBe(true);

    // Even if a stale surface dispatched it, availability is re-read at
    // execution time, so the handler never runs.
    await registry.execute("explorer.delete" as CommandId);
    expect(handler).not.toHaveBeenCalled();

    enabled = true;
    activateMenuItem(deleteItem!, (id) => {
      void registry.execute(id);
    });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
