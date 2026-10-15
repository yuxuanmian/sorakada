/**
 * T016: the pure menu-model helpers.
 *
 * These are the parts of a menu that must be provable without a DOM: what is
 * grouped, what is disabled, which accelerator a row advertises and which
 * identity an activation is reported under.
 */

import { describe, expect, it } from "vitest";

import type { CommandId } from "../../app/commands/commandIds";
import {
  allMenuItems,
  isMenuSectionEmpty,
  menuItemIdentity,
  menuItemLabel,
  withMenuAvailability,
  type SoraMenuModel,
} from "./menuModel";

const model: SoraMenuModel = [
  {
    id: "file",
    items: [
      { id: "new", label: "New", commandId: "file.new", accelerator: "Ctrl+N" },
      { id: "open", label: "Open...", commandId: "file.open" },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [{ id: "explorer", label: "Explorer", commandId: "view.toggleExplorer" }],
    submenus: [
      {
        id: "density",
        label: "Density",
        items: [
          {
            id: "compact",
            label: "Compact",
            commandId: "view.densityCompact",
          },
          {
            id: "default",
            label: "Default",
            commandId: "view.densityDefault",
          },
        ],
      },
    ],
  },
];

describe("menu model structure", () => {
  it("keeps section and submenu grouping in display order", () => {
    expect(model.map((section) => section.id)).toEqual(["file", "view"]);
    expect(model[1].submenus?.map((submenu) => submenu.id)).toEqual(["density"]);
    expect(allMenuItems(model).map((item) => item.id)).toEqual([
      "new",
      "open",
      "explorer",
      "compact",
      "default",
    ]);
  });

  it("reports which sections would render nothing", () => {
    expect(isMenuSectionEmpty({ id: "empty", items: [] })).toBe(true);
    expect(
      isMenuSectionEmpty({
        id: "submenu-only",
        items: [],
        submenus: [{ id: "sub", label: "Sub", items: [] }],
      }),
    ).toBe(false);
  });
});

describe("action identity", () => {
  it("reports a command-backed item under its command id", () => {
    expect(menuItemIdentity({ id: "any", label: "New", commandId: "file.new" })).toBe(
      "file.new",
    );
  });

  it("reports a local item under its own id", () => {
    expect(menuItemIdentity({ id: "debug-range", label: "Virtual range" })).toBe(
      "debug-range",
    );
  });
});

describe("accelerator labels", () => {
  it("appends the keymap accelerator to the label it displays", () => {
    expect(menuItemLabel(allMenuItems(model)[0])).toBe("New\tCtrl+N");
  });

  it("leaves an item without an accelerator exactly as labelled", () => {
    expect(menuItemLabel(allMenuItems(model)[1])).toBe("Open...");
  });
});

describe("availability", () => {
  const enabledOnly = (id: CommandId): boolean => id !== "file.save" && id !== "view.densityDefault";

  it("disables exactly the items the registry refuses", () => {
    const resolved = withMenuAvailability(model, enabledOnly);
    const byId = new Map(
      allMenuItems(resolved).map((item) => [item.id, item.disabled === true]),
    );

    expect(byId.get("new")).toBe(false);
    expect(byId.get("default")).toBe(true);
    expect(byId.get("compact")).toBe(false);
  });

  it("leaves items without a command id alone", () => {
    const local: SoraMenuModel = [
      { id: "debug", items: [{ id: "range", label: "Range", disabled: true }] },
    ];
    expect(withMenuAvailability(local, () => true)[0].items[0].disabled).toBe(
      true,
    );
  });

  it("re-enables an item a stale model had disabled", () => {
    const stale: SoraMenuModel = [
      {
        id: "file",
        items: [
          {
            id: "new",
            label: "New",
            commandId: "file.new",
            disabled: true,
          },
        ],
      },
    ];
    expect(withMenuAvailability(stale, () => true)[0].items[0].disabled).toBeUndefined();
  });

  it("disables a submenu whose items are all unavailable", () => {
    const resolved = withMenuAvailability(model, (id) => id !== "view.densityCompact" && id !== "view.densityDefault");
    expect(resolved[1].submenus?.[0].disabled).toBe(true);
  });

  it("keeps a submenu enabled while at least one item is available", () => {
    const resolved = withMenuAvailability(model, (id) => id !== "view.densityDefault");
    expect(resolved[1].submenus?.[0].disabled).toBe(false);
  });

  it("does not mutate the model it was given", () => {
    withMenuAvailability(model, () => false);
    expect(allMenuItems(model).every((item) => item.disabled === undefined)).toBe(
      true,
    );
  });
});
