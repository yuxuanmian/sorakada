/**
 * The Sorakada menu model (007 T013, T016, T032).
 *
 * A menu surface is described as data — sections, items, submenus — and never as
 * library props. `SoraMenu` and `SoraContextMenu` render that data, so feature
 * code depends on Sorakada concepts (`label`, `accelerator`, `disabled`,
 * `commandId`) instead of a third-party component API, and every model helper
 * here stays pure enough to test without a DOM.
 */

import type { ReactNode } from "react";

import type { CommandId } from "../../app/commands/commandIds";

/** One actionable menu entry. */
export interface SoraMenuItem {
  /** Stable identity inside one model; unique across the whole model. */
  id: string;
  /** What the user reads. */
  label: string;
  /** Display-only accelerator text, always derived from the keymap profile. */
  accelerator?: string;
  /** Optional leading glyph, already rendered by the caller's icon provider. */
  icon?: ReactNode;
  /** Whether the entry may be activated right now. */
  disabled?: boolean;
  /**
   * The canonical command this entry dispatches.
   *
   * Presence is what makes availability derive from the shared command registry
   * rather than from a menu-local decision.
   */
  commandId?: CommandId;
}

/** A labelled group of items inside one section. */
export interface SoraMenuGroup {
  id: string;
  label?: string;
  items: readonly SoraMenuItem[];
}

/** A nested menu opened from one item. */
export interface SoraSubmenu {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  items: readonly SoraMenuItem[];
}

/** One top-level popup section; sections are separated by a divider. */
export interface SoraMenuSection {
  id: string;
  /** Optional heading rendered above the items. */
  label?: string;
  items: readonly SoraMenuItem[];
  /** Submenus rendered after the section's plain items. */
  submenus?: readonly SoraSubmenu[];
}

/** The whole menu, in display order. */
export type SoraMenuModel = readonly SoraMenuSection[];

/**
 * The identity an activation is reported under.
 *
 * A command-backed item reports its command id, so two surfaces that offer the
 * same command are provably the same action; a local item reports its own id.
 */
export function menuItemIdentity(item: SoraMenuItem): string {
  return item.commandId ?? item.id;
}

/** The text a menu row displays, including its accelerator when it has one. */
export function menuItemLabel(item: SoraMenuItem): string {
  return item.accelerator === undefined
    ? item.label
    : `${item.label}\t${item.accelerator}`;
}

/** Every item of the model, submenu items included, in display order. */
export function allMenuItems(model: SoraMenuModel): SoraMenuItem[] {
  const items: SoraMenuItem[] = [];
  for (const section of model) {
    items.push(...section.items);
    for (const submenu of section.submenus ?? []) {
      items.push(...submenu.items);
    }
  }
  return items;
}

/** Whether a section would render nothing at all. */
export function isMenuSectionEmpty(section: SoraMenuSection): boolean {
  return section.items.length === 0 && (section.submenus ?? []).length === 0;
}

/**
 * Re-derives every item's `disabled` flag from one availability decision.
 *
 * The registry is the single availability authority, so a menu never decides on
 * its own that a command may run. Items without a `commandId` keep the disabled
 * state their model declared (for example a debug-only or purely local entry),
 * and a submenu whose items all became unavailable is disabled as a whole rather
 * than opening onto nothing.
 */
export function withMenuAvailability(
  model: SoraMenuModel,
  isEnabled: (commandId: CommandId) => boolean,
): SoraMenuModel {
  return model.map((section) => {
    const items = section.items.map((item) =>
      resolveItemAvailability(item, isEnabled),
    );
    const submenus = section.submenus?.map((submenu) => {
      const submenuItems = submenu.items.map((item) =>
        resolveItemAvailability(item, isEnabled),
      );
      const allUnavailable =
        submenuItems.length > 0 && submenuItems.every((item) => item.disabled);
      return {
        ...submenu,
        items: submenuItems,
        disabled: submenu.disabled === true || allUnavailable,
      };
    });

    return {
      ...section,
      items,
      ...(submenus === undefined ? {} : { submenus }),
    };
  });
}

function resolveItemAvailability(
  item: SoraMenuItem,
  isEnabled: (commandId: CommandId) => boolean,
): SoraMenuItem {
  if (item.commandId === undefined) {
    return item;
  }
  const enabled = isEnabled(item.commandId);
  if (enabled) {
    // An item the registry allows must not stay disabled because a stale model
    // said so; the registry decision is re-applied on every render.
    const { disabled: _disabled, ...rest } = item;
    return rest;
  }
  return { ...item, disabled: true };
}
