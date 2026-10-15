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
import type { AppTranslator, TranslationKey } from "../../i18n";
import { t } from "../../i18n";
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
  labelKey: TranslationKey;
  readonly label?: string;
}

export interface AppMenuSubmenuSpec {
  id: string;
  labelKey: TranslationKey;
  items: readonly AppMenuEntry[];
  readonly label?: string;
}

/** A section of the static catalogue, with any submenus it owns. */
export interface AppMenuSectionSpec {
  id: string;
  labelKey: TranslationKey;
  items: readonly AppMenuEntry[];
  submenus?: readonly AppMenuSubmenuSpec[];
  readonly label?: string;
}

function entry(commandId: CommandId, labelKey: TranslationKey): AppMenuEntry {
  return {
    commandId,
    labelKey,
    get label() {
      return t(labelKey);
    },
  };
}

function submenu(
  id: string,
  labelKey: TranslationKey,
  items: readonly AppMenuEntry[],
): AppMenuSubmenuSpec {
  return {
    id,
    labelKey,
    items,
    get label() {
      return t(labelKey);
    },
  };
}

function section(
  id: string,
  labelKey: TranslationKey,
  items: readonly AppMenuEntry[],
  submenus?: readonly AppMenuSubmenuSpec[],
): AppMenuSectionSpec {
  return {
    id,
    labelKey,
    items,
    ...(submenus === undefined ? {} : { submenus }),
    get label() {
      return t(labelKey);
    },
  };
}

/**
 * The catalogue, in display order.
 *
 * It mirrors the command set the native menu exposed, so no existing action loses
 * its discoverable route: File actions, Edit actions and the View/shell toggles
 * are all still one popup away (FR-021, FR-025, T062).
 */
export const APP_MENU_SECTIONS: readonly AppMenuSectionSpec[] = [
  section("file", "ui.menu.sections.file", [
    entry("file.new", "ui.menu.items.file.new"),
    entry("file.open", "ui.menu.items.file.open"),
    entry("workspace.openFolder", "ui.menu.items.file.openFolder"),
    entry("workspace.closeFolder", "ui.menu.items.file.closeFolder"),
    entry("file.save", "ui.menu.items.file.save"),
    entry("file.saveAs", "ui.menu.items.file.saveAs"),
    entry("file.close", "ui.menu.items.file.close"),
    entry("app.exit", "ui.menu.items.file.exit"),
  ]),
  section("edit", "ui.menu.sections.edit", [
    entry("editor.undo", "ui.menu.items.edit.undo"),
    entry("editor.redo", "ui.menu.items.edit.redo"),
  ]),
  section(
    "view",
    "ui.menu.sections.view",
    [
      entry("view.toggleExplorer", "ui.menu.items.view.explorer"),
      entry("view.resetSidebarWidth", "ui.menu.items.view.resetSidebarWidth"),
    ],
    [
      submenu("density", "ui.menu.submenus.density.label", [
        entry("view.densityCompact", "ui.menu.submenus.density.compact"),
        entry("view.densityDefault", "ui.menu.submenus.density.default"),
        entry("view.densityComfortable", "ui.menu.submenus.density.comfortable"),
      ]),
      submenu("debug", "ui.menu.submenus.debug.label", [
        entry("view.toggleVirtualRange", "ui.menu.submenus.debug.virtualRange"),
        entry("view.toggleTreeRowBounds", "ui.menu.submenus.debug.treeRowBounds"),
        entry("view.debugLargeTree", "ui.menu.submenus.debug.largeTree"),
        entry("view.debugManyTabs", "ui.menu.submenus.debug.manyTabs"),
      ]),
    ],
  ),
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
  /**
   * Optional translate function; defaults to calling `t` from `src/i18n` at build time.
   */
  t?: AppTranslator;
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
  const { isEnabled, developer = false, t: translate = t } = options;

  const toItem = (entryItem: AppMenuEntry): SoraMenuItem => {
    const accelerator = acceleratorFor(entryItem.commandId);
    return {
      id: entryItem.commandId,
      label: translate(entryItem.labelKey),
      commandId: entryItem.commandId,
      ...(accelerator === undefined ? {} : { accelerator }),
    };
  };

  const sections: SoraMenuSection[] = APP_MENU_SECTIONS.map((spec) => {
    const submenus: SoraSubmenu[] = (spec.submenus ?? [])
      // A production build omits the development-only diagnostics entirely
      // (T065, T184) rather than shipping a permanently disabled submenu.
      .filter((submenu) => submenu.id !== "debug" || developer)
      .map((submenu) => ({
        id: submenu.id,
        label: translate(submenu.labelKey),
        items: submenu.items.map(toItem),
      }));

    return {
      id: spec.id,
      label: translate(spec.labelKey),
      items: spec.items.map(toItem),
      ...(submenus.length === 0 ? {} : { submenus }),
    };
  });

  return withMenuAvailability(sections, isEnabled);
}
