/**
 * `SoraMenu` — the only 007 wrapper over `@base-ui/react/menu` (007 T013).
 *
 * Feature code describes a menu as a `SoraMenuModel` and receives the activated
 * item; it never sees a Base UI prop, type or component. Availability is applied
 * by the caller through `withMenuAvailability`, so the registry stays the single
 * availability authority and this wrapper owns presentation only.
 */

import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";

import { useOverlayContainer } from "../overlay/OverlayRoot";
import "../ui.css";
import { SoraMenuSections } from "./menuParts";
import type { SoraMenuItem, SoraMenuModel } from "./menuModel";

export type SoraMenuSide = "bottom" | "top" | "left" | "right";
export type SoraMenuAlign = "start" | "center" | "end";

export interface SoraMenuProps {
  /** The menu content, in display order. */
  model: SoraMenuModel;
  /** The trigger's content; the wrapper renders the button element itself. */
  trigger: ReactNode;
  /** Accessible name for the trigger button. */
  triggerLabel: string;
  /** Called with the activated item; disabled items never reach it. */
  onAction(item: SoraMenuItem): void;
  /** Extra class names for the trigger button. */
  triggerClassName?: string;
  /** Controlled open state; omit for an uncontrolled menu. */
  open?: boolean;
  /** Reports open/closed transitions. */
  onOpenChange?(open: boolean): void;
  /** Which side of the trigger the popup prefers. */
  side?: SoraMenuSide;
  /** Alignment against that side. */
  align?: SoraMenuAlign;
  /**
   * Whether the popup takes the page into a modal state while open.
   *
   * Defaults to `false`: this is a desktop shell, so the window controls, the
   * Sidebar splitter and the Tab strip stay interactive and an outside press
   * still dismisses the menu.
   */
  modal?: boolean;
}

/** Renders a Sorakada menu with its trigger. */
export function SoraMenu({
  model,
  trigger,
  triggerLabel,
  onAction,
  triggerClassName,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  modal = false,
}: SoraMenuProps) {
  const container = useOverlayContainer();

  const triggerClasses =
    triggerClassName === undefined
      ? "sora-menu__trigger"
      : `sora-menu__trigger ${triggerClassName}`;

  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
      }}
      modal={modal}
    >
      <Menu.Trigger className={triggerClasses} aria-label={triggerLabel}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal container={container ?? undefined}>
        <Menu.Positioner
          className="sora-menu__positioner"
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
        >
          <Menu.Popup className="sora-menu__popup">
            <SoraMenuSections model={model} onAction={onAction} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
