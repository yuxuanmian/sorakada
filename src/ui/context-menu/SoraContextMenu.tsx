/**
 * `SoraContextMenu` — the only 007 wrapper over `@base-ui/react/context-menu`
 * (007 T014).
 *
 * It exists for one 007 requirement: the Explorer keeps **one** controlled
 * operation target instead of an authoritative menu state per (recyclable) row.
 * The trigger covers a whole region — the Tree body — and reports the pointer
 * target *before* the popup opens, so the caller can capture the logical row and
 * derive the operation context exactly once.
 *
 * Keyboard navigation, focus handling, outside-press dismissal and portal
 * placement come from the headless primitive; the popup body, its CSS contract
 * and the item model stay Sorakada-owned.
 */

import type { ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";

import { useOverlayContainer } from "../overlay/OverlayRoot";
import "../ui.css";
import { SoraMenuSections } from "../menu/menuParts";
import type { SoraMenuItem, SoraMenuModel } from "../menu/menuModel";

/**
 * The pointer context of the gesture that opens a context menu.
 *
 * Deliberately a plain DOM value rather than a primitive's event type, so the
 * caller can inspect the target without importing the dependency.
 */
export interface SoraContextTarget {
  /** The element under the pointer, or `null` when the event had no element. */
  element: Element | null;
  /** Viewport coordinates of the gesture. */
  x: number;
  y: number;
}

export interface SoraContextMenuProps {
  /** The region that opens the menu on right click. */
  children: ReactNode;
  /** The menu content, in display order. */
  model: SoraMenuModel;
  /** Called with the activated item. */
  onAction(item: SoraMenuItem): void;
  /** Reports the gesture target before the popup opens. */
  onTarget?(target: SoraContextTarget): void;
  /** Reports open/closed transitions. */
  onOpenChange?(open: boolean): void;
  /** Accessible name for the popup. */
  ariaLabel?: string;
  /** Extra class names for the trigger region. */
  className?: string;
  /** Controlled open state; omit for an uncontrolled menu. */
  open?: boolean;
  /**
   * Swallows the browser's own context menu on the trigger region.
   *
   * Defaults to `true`, which is what a desktop context menu needs; the Tree
   * also relies on it so a right click never mixes the native menu with ours.
   */
  preventNativeMenu?: boolean;
}

/** Renders a Sorakada context menu over its trigger region. */
export function SoraContextMenu({
  children,
  model,
  onAction,
  onTarget,
  onOpenChange,
  ariaLabel,
  className,
  open,
  preventNativeMenu = true,
}: SoraContextMenuProps) {
  const container = useOverlayContainer();

  const triggerClasses =
    className === undefined
      ? "sora-context-menu__trigger"
      : `sora-context-menu__trigger ${className}`;

  return (
    <ContextMenu.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
      }}
    >
      <ContextMenu.Trigger
        className={triggerClasses}
        onContextMenu={(event) => {
          if (preventNativeMenu) {
            event.preventDefault();
          }
          const target = event.target;
          onTarget?.({
            element:
              target !== null && "closest" in (target as Element)
                ? (target as Element)
                : null,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={container ?? undefined}>
        <ContextMenu.Positioner
          className="sora-menu__positioner sora-context-menu__positioner"
          collisionPadding={8}
        >
          <ContextMenu.Popup
            className="sora-menu__popup sora-context-menu__popup"
            aria-label={ariaLabel}
          >
            <SoraMenuSections model={model} onAction={onAction} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
