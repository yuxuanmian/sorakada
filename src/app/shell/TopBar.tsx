/**
 * The TopBar region (007 T042, T043, FR-004, FR-006, FR-007, FR-011).
 *
 * It is the application/window-level region: an App Menu slot, an explicit
 * draggable surface, and a separate native-control region. Document Tabs are
 * deliberately not here (FR-004), and 007 does not grow this into a toolbar of
 * File/Open/Save buttons (FR-011).
 *
 * Interaction rules:
 *
 * - the drag surface reacts to the first primary-button press only when it did
 *   not land on an interactive descendant, so a menu or window-control click is
 *   never swallowed by a window move (FR-006);
 * - the second press of a double-click dispatches the canonical
 *   `window.toggleMaximize` command before WebView2 can enter another native
 *   drag loop, and therefore does so exactly once (FR-007);
 * - the visible Close control dispatches `window.close`, which reaches the
 *   ordinary close request and therefore the unsaved-work guard (FR-008).
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CommandId } from "../commands/commandIds";
import { AppIcon } from "./AppIcon";
import { requestTopBarMouseDown } from "./topBarGesture";

export interface TopBarProps {
  /** The compact App Menu slot. */
  appMenu: ReactNode;
  /** Dispatches canonical commands through the shared registry. */
  onCommand(id: CommandId): void;
  /** Starts a native window move from the non-interactive drag surface. */
  onStartDrag(): void;
  /**
   * Whether native window control exists in this runtime.
   *
   * In browser-only development the native controls are hidden rather than
   * rendered as buttons that could only fail (US1-AC8, FR-007).
   */
  nativeChromeAvailable: boolean;
  /** Whether the window is currently maximized, for the restore glyph. */
  maximized: boolean;
}

/** Renders the TopBar. */
export function TopBar({
  appMenu,
  onCommand,
  onStartDrag,
  nativeChromeAvailable,
  maximized,
}: TopBarProps) {
  const { t } = useTranslation();
  const handlers = {
    startDrag: onStartDrag,
    toggleMaximize: () => {
      onCommand("window.toggleMaximize");
    },
  };

  return (
    <header className="top-bar">
      <div
        className="top-bar__drag"
        // The whole strip is the gesture surface; the decision checks the actual
        // target, so an interactive descendant opts out of both behaviours.
        onMouseDown={(event) => {
          requestTopBarMouseDown(
            event.target,
            event.button,
            event.detail,
            handlers,
          );
        }}
      >
        <div className="top-bar__menu">{appMenu}</div>
        <div className="top-bar__drag-fill" aria-hidden="true" />
      </div>

      {nativeChromeAvailable ? (
        <div className="top-bar__window-controls">
          <button
            type="button"
            className="top-bar__control"
            aria-label={t("ui.topBar.minimize")}
            title={t("ui.topBar.minimize")}
            data-sora-interactive=""
            onClick={() => {
              onCommand("window.minimize");
            }}
          >
            <AppIcon name="minimize" />
          </button>
          <button
            type="button"
            className="top-bar__control"
            aria-label={maximized ? t("ui.topBar.restore") : t("ui.topBar.maximize")}
            title={maximized ? t("ui.topBar.restore") : t("ui.topBar.maximize")}
            data-sora-interactive=""
            onClick={() => {
              onCommand("window.toggleMaximize");
            }}
          >
            <AppIcon name={maximized ? "restore" : "maximize"} />
          </button>
          <button
            type="button"
            className="top-bar__control top-bar__control--close"
            aria-label={t("ui.topBar.closeWindow")}
            title={t("ui.topBar.close")}
            data-sora-interactive=""
            onClick={() => {
              // Never a destroy: this is the ordinary close request, so the
              // dirty-document guard stays authoritative (FR-008).
              onCommand("window.close");
            }}
          >
            <AppIcon name="close" />
          </button>
        </div>
      ) : null}
    </header>
  );
}
