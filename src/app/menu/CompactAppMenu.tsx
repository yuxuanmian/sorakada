/**
 * The compact in-WebView App Menu (007 T060, T061, FR-021..FR-025, SR-006).
 *
 * It replaces the visible native File/Edit/View menu as the single discoverability
 * trigger for existing commands. It is presentation only: it builds its model from
 * the shared catalogue plus the registry's availability, and every activation is
 * dispatched through the same `dispatch()` path the keyboard, the Explorer and the
 * window controls use, so no menu-local business logic can appear here (FR-016).
 *
 * Because it is a WebView popup rather than a native menu, it also works in
 * browser-only development for the commands whose handlers are available there
 * (FR-024).
 */

import { useState } from "react";

import type { CommandId } from "../commands/commandIds";
import { SoraMenu } from "../../ui/menu/SoraMenu";
import { AppIcon } from "../shell/AppIcon";
import { buildAppMenuModel } from "./appMenuModel";

export interface CompactAppMenuProps {
  /** The shared registry's availability decision (FR-022). */
  isEnabled(commandId: CommandId): boolean;
  /** Whether the development-only diagnostics submenu is built (T065). */
  developer: boolean;
  /** Dispatches a command through the shared registry. */
  onCommand(id: CommandId): void;
}

/** Renders the TopBar's App Menu trigger and popup. */
export function CompactAppMenu({
  isEnabled,
  developer,
  onCommand,
}: CompactAppMenuProps) {
  /**
   * The popup's open state is owned here, and that is load-bearing.
   *
   * Availability is read from the shared command registry, which the application
   * fills in its mount effect — **after** the first render. A menu whose model is
   * only built when the shell happens to re-render therefore opened its first popup
   * from an empty registry, with every entry greyed out.
   *
   * Opening is a state change in this component, so the model below is rebuilt at
   * exactly the moment the popup appears, from the registry as it is then. That also
   * keeps an already-open popup current, because every availability input (document
   * snapshot, Workspace, Explorer state) re-renders the shell anyway.
   */
  const [open, setOpen] = useState(false);

  // Rebuilt on every render, so enabled state and accelerator text are always the
  // current registry/keymap answer rather than a cached menu snapshot.
  const model = buildAppMenuModel({ isEnabled, developer });

  return (
    <SoraMenu
      model={model}
      open={open}
      onOpenChange={setOpen}
      triggerLabel="Application menu"
      triggerClassName="compact-app-menu__trigger"
      trigger={
        <>
          <span className="compact-app-menu__name">Sorakada</span>
          <AppIcon name="chevron-down" className="compact-app-menu__chevron" />
        </>
      }
      onAction={(item) => {
        if (item.commandId !== undefined) {
          onCommand(item.commandId);
        }
      }}
    />
  );
}
