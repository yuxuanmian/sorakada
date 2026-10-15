/**
 * The App Menu's availability must be read from the registry *as it is now*.
 *
 * The registry is populated in the application's mount effect, i.e. **after** the
 * first render. A menu whose model is only built when the shell happens to
 * re-render therefore opened once with every entry greyed out — the reported
 * "first click shows everything disabled" defect. Availability is a projection of a
 * mutable registry, so it has to be re-read at the moment the popup is opened.
 *
 * These tests pin both halves of that contract: the mechanism (an empty registry
 * really does disable everything) and the invariant that every command any menu
 * surface can name is actually registered by the application.
 */

import { describe, expect, it } from "vitest";

import type { CommandId } from "../commands/commandIds";
import { COMMAND_IDS } from "../commands/commandIds";
import { createCommandRegistry } from "../commands/commandRegistry";
import type { WorkContext } from "../workspace/workContext";
import { deriveFileOperationContext } from "../explorer/explorerActions";
import {
  buildExplorerMoreMenuModel,
  explorerHeaderActions,
} from "../explorer/explorerHeaderActions";
import { EXPLORER_MENU_ACTIONS } from "../explorer/explorerMenuModel";
import { collectSourceFiles } from "../../test-support/sourceInventory";
import { allMenuItems } from "../../ui/menu/menuModel";
import { buildAppMenuModel } from "./appMenuModel";

const workspace: WorkContext = {
  id: "workspace-1",
  rootPath: "C:\\work",
  canonicalRootPath: "C:\\work",
  comparisonKey: "c:\\work",
  displayName: "work",
};

/** The command ids every menu surface in the application can offer. */
function surfacedCommandIds(): CommandId[] {
  const ids = new Set<CommandId>();

  // The compact App Menu, including the development-only diagnostics.
  for (const item of allMenuItems(
    buildAppMenuModel({ isEnabled: () => true, developer: true }),
  )) {
    if (item.commandId !== undefined) {
      ids.add(item.commandId);
    }
  }

  // The Explorer Header's own actions.
  for (const action of explorerHeaderActions({
    hasWorkspace: true,
    hasExpandedDirectories: true,
    activeDocumentPathKey: "c:\\work\\a.ts",
    workspaceComparisonKey: "c:\\work",
  })) {
    ids.add(action.commandId);
  }

  // The Explorer `More` popup and the Explorer context menu.
  for (const item of allMenuItems(
    buildExplorerMoreMenuModel(deriveFileOperationContext(workspace, null), {
      isEnabled: () => true,
    }),
  )) {
    if (item.commandId !== undefined) {
      ids.add(item.commandId);
    }
  }
  for (const action of EXPLORER_MENU_ACTIONS) {
    ids.add(action);
  }

  return [...ids].sort();
}

/** The command ids `App.tsx` registers with the shared registry. */
function registeredCommandIds(): Set<string> {
  const app = collectSourceFiles("src/app", [".tsx"]).find(
    (file) => file.relativePath === "src/app/App.tsx",
  );
  expect(app).toBeDefined();

  const ids = new Set<string>();
  for (const match of app!.text.matchAll(/registry\.register\(\s*"([^"]+)"/g)) {
    ids.add(match[1]);
  }
  return ids;
}

describe("App Menu availability comes from the live registry", () => {
  it("disables every entry while the registry is still empty (the stale state)", () => {
    // This is exactly what the first render used to produce: the registry is filled
    // in the mount effect, so it is empty while React renders the shell.
    const registry = createCommandRegistry();
    const model = buildAppMenuModel({
      isEnabled: (id) => registry.isEnabled(id),
      developer: true,
    });

    const items = allMenuItems(model);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.disabled === true)).toBe(true);
  });

  it("re-reads availability on every build, so opening the menu later is correct", () => {
    const registry = createCommandRegistry();
    const first = buildAppMenuModel({
      isEnabled: (id) => registry.isEnabled(id),
      developer: true,
    });
    expect(allMenuItems(first).every((item) => item.disabled === true)).toBe(
      true,
    );

    // The mount effect has since registered the application's commands.
    for (const id of COMMAND_IDS) {
      registry.register(id, { execute: () => undefined });
    }

    const second = buildAppMenuModel({
      isEnabled: (id) => registry.isEnabled(id),
      developer: true,
    });
    expect(allMenuItems(second).some((item) => item.disabled !== true)).toBe(
      true,
    );
    expect(allMenuItems(second).every((item) => item.disabled === true)).toBe(
      false,
    );
  });

  it("keeps a command the registry refuses disabled", () => {
    const registry = createCommandRegistry();
    for (const id of COMMAND_IDS) {
      registry.register(id, {
        execute: () => undefined,
        // A document-dependent command is the realistic disabled case.
        isEnabled: () => id !== "file.save",
      });
    }

    const model = buildAppMenuModel({
      isEnabled: (id) => registry.isEnabled(id),
      developer: true,
    });
    const disabled = allMenuItems(model)
      .filter((item) => item.disabled === true)
      .map((item) => item.commandId);

    expect(disabled).toEqual(["file.save"]);
  });
});

describe("every menu action has a handler (FR-096)", () => {
  it("registers every command any menu surface can dispatch", () => {
    const registered = registeredCommandIds();
    expect(registered.size).toBeGreaterThan(0);

    const missing = surfacedCommandIds().filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  });

  it("registers no command id outside the declared catalogue", () => {
    for (const id of registeredCommandIds()) {
      expect(COMMAND_IDS, id).toContain(id);
    }
  });
});

describe("Tauri-only commands are gated on the runtime (T224, T063, FR-024)", () => {
  /** The application source, read once. */
  function appSource(): string {
    const app = collectSourceFiles("src/app", [".tsx"]).find(
      (file) => file.relativePath === "src/app/App.tsx",
    );
    expect(app).toBeDefined();
    return app!.text;
  }

  /** The registration block for one command id. */
  function registrationBlock(source: string, commandId: string): string {
    const start = source.indexOf(`registry.register("${commandId}"`);
    expect(start, commandId).toBeGreaterThanOrEqual(0);
    const next = source.indexOf("registry.register(", start + 1);
    return source.slice(start, next === -1 ? source.length : next);
  }

  /**
   * Exit and the window controls all reach the native window API, so each must
   * declare its runtime availability: a browser-only session must never be able to
   * dispatch them and reach an unavailable Tauri call.
   *
   * Dialog-backed commands (`file.open`, `workspace.openFolder`, Save As) are
   * deliberately *not* in this set: T224 scopes the gate to the window/Exit
   * commands, and the dialog path reports its own failure through the application
   * error surface.
   */
  const NATIVE_WINDOW_COMMANDS = [
    "app.exit",
    "window.minimize",
    "window.toggleMaximize",
    "window.close",
  ] as const;

  it("declares runtime availability for every native window command", () => {
    const source = appSource();
    for (const id of NATIVE_WINDOW_COMMANDS) {
      expect(registrationBlock(source, id), id).toContain("isAvailable()");
    }
  });

  it("keeps Exit out of a browser-only App Menu", () => {
    // The menu reads the same registry decision, so an unavailable Exit is shown
    // disabled rather than dispatching a rejected native call (T063).
    const registry = createCommandRegistry();
    for (const id of COMMAND_IDS) {
      registry.register(id, {
        execute: () => undefined,
        isEnabled: () => id !== "app.exit",
      });
    }

    const model = buildAppMenuModel({
      isEnabled: (id) => registry.isEnabled(id),
      developer: false,
    });
    const exit = allMenuItems(model).find(
      (item) => item.commandId === "app.exit",
    );
    expect(exit?.disabled).toBe(true);
  });
});
