/**
 * The shared rendering of a `SoraMenuModel` (007 T013, T014).
 *
 * `SoraMenu` and `SoraContextMenu` present the same items, so the item/group/
 * separator/submenu rendering lives here once. Both wrappers keep their own
 * trigger and positioning behaviour; this module owns only the popup body, which
 * is why a feature cannot accidentally render a "second kind" of menu item.
 *
 * Base UI state attributes (`data-highlighted`, `data-disabled`, `data-open`) are
 * documented styling hooks and are used only from `ui.css`, scoped to the
 * Sorakada classes below.
 */

import { Fragment } from "react";
import { Menu } from "@base-ui/react/menu";

import { useOverlayContainer } from "../overlay/OverlayRoot";
import type { SoraMenuItem, SoraMenuModel, SoraSubmenu } from "./menuModel";

export interface SoraMenuSectionsProps {
  model: SoraMenuModel;
  /** Called with the activated item; the wrapper decides what that means. */
  onAction(item: SoraMenuItem): void;
}

/** Renders one model as the body of a popup. */
export function SoraMenuSections({ model, onAction }: SoraMenuSectionsProps) {
  return (
    <Menu.Viewport className="sora-menu__viewport">
      {model.map((section, index) => (
        <Fragment key={section.id}>
          {index > 0 ? (
            <Menu.Separator className="sora-menu__separator" />
          ) : null}
          <Menu.Group className="sora-menu__group">
            {section.label === undefined ? null : (
              <Menu.GroupLabel className="sora-menu__group-label">
                {section.label}
              </Menu.GroupLabel>
            )}
            {section.items.map((item) => (
              <SoraMenuRow key={item.id} item={item} onAction={onAction} />
            ))}
            {(section.submenus ?? []).map((submenu) => (
              <SoraSubmenuRow
                key={submenu.id}
                submenu={submenu}
                onAction={onAction}
              />
            ))}
          </Menu.Group>
        </Fragment>
      ))}
    </Menu.Viewport>
  );
}

/** One actionable row. */
function SoraMenuRow({
  item,
  onAction,
}: {
  item: SoraMenuItem;
  onAction(item: SoraMenuItem): void;
}) {
  return (
    <Menu.Item
      className="sora-menu__item"
      label={item.label}
      disabled={item.disabled === true}
      onClick={() => {
        onAction(item);
      }}
    >
      {item.icon === undefined ? (
        <span className="sora-menu__item-icon" aria-hidden="true" />
      ) : (
        <span className="sora-menu__item-icon" aria-hidden="true">
          {item.icon}
        </span>
      )}
      <span className="sora-menu__item-label">{item.label}</span>
      {item.accelerator === undefined ? null : (
        <span className="sora-menu__item-accelerator">{item.accelerator}</span>
      )}
    </Menu.Item>
  );
}

/** One nested menu. */
function SoraSubmenuRow({
  submenu,
  onAction,
}: {
  submenu: SoraSubmenu;
  onAction(item: SoraMenuItem): void;
}) {
  const container = useOverlayContainer();

  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger
        className="sora-menu__item sora-menu__item--submenu"
        label={submenu.label}
        disabled={submenu.disabled === true}
      >
        {submenu.icon === undefined ? (
          <span className="sora-menu__item-icon" aria-hidden="true" />
        ) : (
          <span className="sora-menu__item-icon" aria-hidden="true">
            {submenu.icon}
          </span>
        )}
        <span className="sora-menu__item-label">{submenu.label}</span>
        <span className="sora-menu__item-arrow" aria-hidden="true">
          ›
        </span>
      </Menu.SubmenuTrigger>
      <Menu.Portal container={container ?? undefined}>
        <Menu.Positioner
          className="sora-menu__positioner"
          side="inline-end"
          align="start"
          sideOffset={2}
          collisionPadding={8}
        >
          <Menu.Popup className="sora-menu__popup">
            <SoraMenuSections model={[submenu]} onAction={onAction} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
