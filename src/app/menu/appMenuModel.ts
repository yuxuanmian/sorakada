/**
 * The compact App Menu presentation model (007 T032, FR-021..FR-025).
 *
 * The model is data: which command sits where, and under which label. It holds no
 * behaviour, no availability state and no shortcut text of its own —
 * accelerators are read from the same keymap profile the keyboard dispatcher
 * uses (FR-023), and enabled state is applied from the shared command registry at
 * build time (FR-022), so the popup can never disagree with the rest of the
 * application.
 *
 * `appMenu.ts` (the native visible menu) is retired by 007 (SR-006); this model is
 * what replaces its discoverability without replacing its command ownership.
 */

import type { CommandId } from "../commands/commandIds";
import { acceleratorFor } from "../commands/ideaKeymap";
import type { UiDensity } from "../shell/uiPreferences";
import type {
  SoraMenuItem,
  SoraMenuModel,
  SoraMenuSection,
  SoraSubmenu,
} from "../../ui/menu/menuModel";
import { withMenuAvailability } from "../../ui/menu/menuModel";

/** One entry of the static catalogue. */
export interface AppMenuEntry {
  commandId: CommandId;
  label: string;
}

/** A section of the static catalogue, with any submenus it owns. */
export interface AppMenuSectionSpec {
  id: string;
  label: string;
  items: readonly AppMenuEntry[];
  submenus?: readonly {
    id: string;
    label: string;
    items: readonly AppMenuEntry[];
  }[];
}

/**
 * The catalogue, in display order.
 *
 * It mirrors the command set the native menu exposed, so no existing action loses
 * its discoverable route: File actions, Edit actions and the View/shell toggles
 * are all still one popup away (FR-021, FR-025, T062).
 */
export const APP_MENU_SECTIONS: readonly AppMenuSectionSpec[] = [
  {
    id: "file",
    label: "File",
    items: [
      { commandId: "file.new", label: "New" },
      { commandId: "file.open", label: "Open..." },
      { commandId: "workspace.openFolder", label: "Open Folder..." },
      { commandId: "workspace.closeFolder", label: "Close Folder" },
      { commandId: "file.save", label: "Save" },
      { commandId: "file.saveAs", label: "Save As..." },
      { commandId: "file.close", label: "Close" },
      { commandId: "app.exit", label: "Exit" },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    items: [
      { commandId: "editor.undo", label: "Undo" },
      { commandId: "editor.redo", label: "Redo" },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      { commandId: "view.toggleExplorer", label: "Explorer" },
      { commandId: "view.resetSidebarWidth", label: "Reset Sidebar Width" },
    ],
    submenus: [
      {
        id: "density",
        label: "Density",
        items: [
          { commandId: "view.densityCompact", label: "Compact" },
          { commandId: "view.densityDefault", label: "Default" },
          { commandId: "view.densityComfortable", label: "Comfortable" },
        ],
      },
      {
        id: "debug",
        label: "UI Debug",
        items: [
          { commandId: "view.toggleVirtualRange", label: "Virtual Range" },
          { commandId: "view.toggleTreeRowBounds", label: "Tree Row Bounds" },
          { commandId: "view.debugLargeTree", label: "10,000-Row Tree" },
          { commandId: "view.debugManyTabs", label: "100 Tabs" },
        ],
      },
    ],
  },
];

/** The command id a density preset is selected through (FR-088, T155). */
export const DENSITY_COMMANDS: Readonly<Record<UiDensity, CommandId>> = {
  compact: "view.densityCompact",
  default: "view.densityDefault",
  comfortable: "view.densityComfortable",
};

export interface BuildAppMenuOptions {
  /**
   * The shared availability decision, read from the command registry.
   *
   * An unregistered command is always unavailable, so the popup cannot offer an
   * action the registry would refuse (FR-022, T063).
   */
  isEnabled(commandId: CommandId): boolean;
  /**
   * Whether the development-only diagnostics submenu is built at all.
   *
   * A production build passes `false`, so unfinished debug tooling is omitted
   * without changing any other command's behaviour (T065, T184).
   */
  developer?: boolean;
}

function toItem(entry: AppMenuEntry): SoraMenuItem {
  const accelerator = acceleratorFor(entry.commandId);
  return {
    id: entry.commandId,
    label: entry.label,
    commandId: entry.commandId,
    ...(accelerator === undefined ? {} : { accelerator }),
  };
}

/**
 * Builds the menu model from the catalogue plus the caller's availability.
 *
 * Availability is applied by the shared `withMenuAvailability` helper, so this
 * module never contains a second copy of that rule. Nothing is cached: the menu
 * is rebuilt whenever it renders, so enabled state and accelerator text are
 * always current.
 */
export function buildAppMenuModel(
  options: BuildAppMenuOptions,
): SoraMenuModel {
  const { isEnabled, developer = false } = options;

  const sections: SoraMenuSection[] = APP_MENU_SECTIONS.map((spec) => {
    const submenus: SoraSubmenu[] = (spec.submenus ?? [])
      // A production build omits the development-only diagnostics entirely
      // (T065, T184) rather than shipping a permanently disabled submenu.
      .filter((submenu) => submenu.id !== "debug" || developer)
      .map((submenu) => ({
        id: submenu.id,
        label: submenu.label,
        items: submenu.items.map(toItem),
      }));

    return {
      id: spec.id,
      label: spec.label,
      items: spec.items.map(toItem),
      ...(submenus.length === 0 ? {} : { submenus }),
    };
  });

  return withMenuAvailability(sections, isEnabled);
}
