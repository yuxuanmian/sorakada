/**
 * T059: the compact App Menu's pure model.
 *
 * FR-021..FR-023 make three claims about the menu that are provable without a
 * DOM: which commands are grouped where, that accelerator text comes from the
 * keymap profile, and that disabled state comes from the shared registry.
 */

import { describe, expect, it } from "vitest";

import type { CommandId } from "../commands/commandIds";
import { COMMAND_IDS } from "../commands/commandIds";
import { acceleratorFor } from "../commands/ideaKeymap";
import { allMenuItems } from "../../ui/menu/menuModel";
import {
  APP_MENU_SECTIONS,
  DENSITY_COMMANDS,
  buildAppMenuModel,
} from "./appMenuModel";

const everythingEnabled = (): boolean => true;

describe("App Menu group composition", () => {
  it("groups the existing commands into File, Edit and View", () => {
    const model = buildAppMenuModel({ isEnabled: everythingEnabled });
    expect(model.map((section) => section.label)).toEqual([
      "File",
      "Edit",
      "View",
    ]);
  });

  it("keeps every File/Edit action reachable (T062)", () => {
    const model = buildAppMenuModel({ isEnabled: everythingEnabled });
    const ids = allMenuItems(model).map((item) => item.commandId);

    for (const commandId of [
      "file.new",
      "file.open",
      "workspace.openFolder",
      "workspace.closeFolder",
      "file.save",
      "file.saveAs",
      "file.close",
      "app.exit",
      "editor.undo",
      "editor.redo",
    ] satisfies CommandId[]) {
      expect(ids).toContain(commandId);
    }
  });

  it("offers the density and Sidebar entries under View (FR-088, T064)", () => {
    const model = buildAppMenuModel({ isEnabled: everythingEnabled });
    const view = model.find((section) => section.id === "view");
    expect(view?.items.map((item) => item.commandId)).toEqual([
      "view.toggleExplorer",
      "view.resetSidebarWidth",
    ]);

    const density = view?.submenus?.find((submenu) => submenu.id === "density");
    expect(density?.items.map((item) => item.commandId)).toEqual([
      DENSITY_COMMANDS.compact,
      DENSITY_COMMANDS.default,
      DENSITY_COMMANDS.comfortable,
    ]);
  });

  it("only ever references declared command ids", () => {
    const model = buildAppMenuModel({
      isEnabled: everythingEnabled,
      developer: true,
    });
    for (const item of allMenuItems(model)) {
      expect(COMMAND_IDS).toContain(item.commandId);
    }
  });
});

describe("App Menu accelerators come from the keymap profile", () => {
  it("advertises exactly the profile's shortcuts", () => {
    const model = buildAppMenuModel({ isEnabled: everythingEnabled });
    const byCommand = new Map(
      allMenuItems(model).map((item) => [item.commandId, item.accelerator]),
    );

    expect(byCommand.get("file.new")).toBe(acceleratorFor("file.new"));
    expect(byCommand.get("file.save")).toBe("Ctrl+S");
    expect(byCommand.get("file.close")).toBe("Ctrl+W");
  });

  it("advertises nothing for a command the profile does not bind", () => {
    const model = buildAppMenuModel({ isEnabled: everythingEnabled });
    const byCommand = new Map(
      allMenuItems(model).map((item) => [item.commandId, item.accelerator]),
    );

    expect(byCommand.get("explorer.refresh")).toBeUndefined();
    expect(byCommand.get("view.toggleExplorer")).toBeUndefined();
    expect(byCommand.get("app.exit")).toBeUndefined();
  });
});

describe("App Menu availability comes from the registry", () => {
  it("disables exactly the commands the registry refuses (FR-022, T063)", () => {
    const model = buildAppMenuModel({
      isEnabled: (id) => id !== "file.save" && id !== "file.close",
    });
    const disabled = allMenuItems(model)
      .filter((item) => item.disabled === true)
      .map((item) => item.commandId);

    expect(disabled.sort()).toEqual(["file.close", "file.save"]);
  });

  it("treats an unregistered command as unavailable", () => {
    const registered = new Set<CommandId>(["file.new", "view.toggleExplorer"]);
    const model = buildAppMenuModel({
      isEnabled: (id) => registered.has(id),
    });
    const enabled = allMenuItems(model)
      .filter((item) => item.disabled !== true)
      .map((item) => item.commandId);

    expect(enabled.sort()).toEqual(["file.new", "view.toggleExplorer"]);
  });

  it("never offers a native-only command in a browser-only session", () => {
    // T063: the browser runtime reports the Tauri-only commands as unavailable,
    // so the popup cannot turn development into rejected IPC calls.
    const nativeOnly = new Set<CommandId>(["app.exit", "workspace.openFolder"]);
    const model = buildAppMenuModel({
      isEnabled: (id) => !nativeOnly.has(id),
    });

    const disabled = new Set(
      allMenuItems(model)
        .filter((item) => item.disabled === true)
        .map((item) => item.commandId),
    );
    expect(disabled.has("app.exit")).toBe(true);
    expect(disabled.has("workspace.openFolder")).toBe(true);
  });
});

describe("development-only diagnostics (T065)", () => {
  it("is absent from the model unless a developer build asks for it", () => {
    const model = buildAppMenuModel({ isEnabled: everythingEnabled });
    const view = model.find((section) => section.id === "view");
    expect(view?.submenus?.map((submenu) => submenu.id)).toEqual(["density"]);
  });

  it("appears with stable debug command ids in a developer build", () => {
    const model = buildAppMenuModel({
      isEnabled: everythingEnabled,
      developer: true,
    });
    const debug = model
      .find((section) => section.id === "view")
      ?.submenus?.find((submenu) => submenu.id === "debug");

    expect(debug?.items.map((item) => item.commandId)).toEqual([
      "view.toggleVirtualRange",
      "view.toggleTreeRowBounds",
      "view.debugLargeTree",
      "view.debugManyTabs",
    ]);
  });

  it("disables the debug submenu when the debug commands are not registered", () => {
    const model = buildAppMenuModel({
      isEnabled: (id) => !id.startsWith("view.toggle") && !id.startsWith("view.debug"),
      developer: true,
    });
    const debug = model
      .find((section) => section.id === "view")
      ?.submenus?.find((submenu) => submenu.id === "debug");
    expect(debug?.disabled).toBe(true);
  });
});

describe("catalogue shape", () => {
  it("declares every default item once", () => {
    const ids = APP_MENU_SECTIONS.flatMap((section) => section.items).map(
      (item) => item.commandId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is rebuilt on every call rather than cached", () => {
    const first = buildAppMenuModel({ isEnabled: () => true });
    const second = buildAppMenuModel({ isEnabled: () => false });
    expect(first).not.toBe(second);
    expect(allMenuItems(second).every((item) => item.disabled === true)).toBe(
      true,
    );
  });
});
