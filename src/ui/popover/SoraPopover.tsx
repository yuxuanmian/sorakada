/**
 * `SoraPopover` — the Sorakada popover primitive (007 T139, FR-015).
 *
 * The Tab Overview needs a popup that contains *interactive content* (a filter
 * input plus a selectable list), which a menu surface cannot host without
 * fighting its keyboard model. 007 therefore has exactly one popover wrapper, in
 * the same Sorakada-owned layer as the menus, so the filter field and the list
 * stay dependency-free and themeable.
 *
 * It stays non-modal by default: a desktop popup must not lock the rest of the
 * shell, and an outside press still dismisses it.
 */

import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";

import { useOverlayContainer } from "../overlay/OverlayRoot";
import "../ui.css";

export type SoraPopoverSide = "bottom" | "top" | "left" | "right";
export type SoraPopoverAlign = "start" | "center" | "end";

export interface SoraPopoverProps {
  /** The trigger's content; the wrapper renders the button element itself. */
  trigger: ReactNode;
  /** Accessible name for the trigger button. */
  triggerLabel: string;
  /** Extra class names for the trigger button. */
  triggerClassName?: string;
  /** The popup's content. */
  children: ReactNode;
  /** Accessible name for the popup. */
  ariaLabel?: string;
  /** Controlled open state; omit for an uncontrolled popover. */
  open?: boolean;
  /** Reports open/closed transitions. */
  onOpenChange?(open: boolean): void;
  /** Which side of the trigger the popup prefers. */
  side?: SoraPopoverSide;
  /** Alignment against that side. */
  align?: SoraPopoverAlign;
  /** Extra class names for the popup. */
  className?: string;
}

/** Renders a Sorakada popover with its trigger. */
export function SoraPopover({
  trigger,
  triggerLabel,
  triggerClassName,
  children,
  ariaLabel,
  open,
  onOpenChange,
  side = "bottom",
  align = "end",
  className,
}: SoraPopoverProps) {
  const container = useOverlayContainer();

  const triggerClasses =
    triggerClassName === undefined
      ? "sora-popover__trigger"
      : `sora-popover__trigger ${triggerClassName}`;
  const popupClasses =
    className === undefined
      ? "sora-popover__popup"
      : `sora-popover__popup ${className}`;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
      }}
      modal={false}
    >
      <Popover.Trigger className={triggerClasses} aria-label={triggerLabel}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner
          className="sora-popover__positioner"
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
        >
          <Popover.Popup className={popupClasses} aria-label={ariaLabel}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
