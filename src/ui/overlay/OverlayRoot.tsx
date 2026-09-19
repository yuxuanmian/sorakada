/**
 * The single Sorakada-owned overlay/portal boundary (007 T011).
 *
 * Popup surfaces (App Menu, Explorer context menu, Tab Overview, later dialogs)
 * must not be clipped by a Sidebar/Editor `overflow` container, and they must not
 * each invent their own stacking order. This module provides exactly one portal
 * target near the application root plus the hook feature code uses to reach it.
 *
 * The API is deliberately independent of any third-party primitive: a consumer
 * asks for an `HTMLElement | null` and passes it on. `null` is a supported answer
 * (for example before the root has mounted, or in a non-DOM test environment) and
 * means "use the primitives' own default container" rather than "no overlay".
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import "../ui.css";

/** Class the overlay root renders with; the layer tokens live in `global.css`. */
export const OVERLAY_ROOT_CLASS = "sora-overlay-root";

interface OverlayRootContextValue {
  container: HTMLElement | null;
}

/**
 * Default is `null`, so a component rendered outside an `OverlayRoot` still
 * works: Base UI then portals to `document.body`, which is above the shell too.
 */
const OverlayRootContext = createContext<OverlayRootContextValue>({
  container: null,
});

export interface OverlayRootProps {
  /** The application tree, which may render popups into this boundary. */
  children?: ReactNode;
  /** Extra class names for the portal element. */
  className?: string;
}

/**
 * Renders the one portal target and publishes it to its subtree.
 *
 * The element itself never accepts pointer events; each popup re-enables them on
 * its own subtree, which is what keeps a full-viewport portal from swallowing
 * clicks meant for the shell underneath it.
 */
export function OverlayRoot({ children, className }: OverlayRootProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const value = useMemo<OverlayRootContextValue>(
    () => ({ container }),
    [container],
  );

  return (
    <>
      <div
        ref={setContainer}
        className={
          className === undefined
            ? OVERLAY_ROOT_CLASS
            : `${OVERLAY_ROOT_CLASS} ${className}`
        }
        data-sora-overlay-root=""
      />
      <OverlayRootContext.Provider value={value}>
        {children}
      </OverlayRootContext.Provider>
    </>
  );
}

/** The portal target popups should render into, or `null` for the default one. */
export function useOverlayContainer(): HTMLElement | null {
  return useContext(OverlayRootContext).container;
}
