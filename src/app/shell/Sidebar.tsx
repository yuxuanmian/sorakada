/**
 * The Sidebar container.
 *
 * It is a *generic* horizontal panel: 003 puts the Explorer in it, but nothing
 * here is Explorer-specific, so a later Sidebar view can replace the content
 * without touching this layout (FR-091). Width and visibility are transient and
 * process-local — 003 deliberately persists neither (FR-094).
 */

import { useEffect, useState, type ReactNode } from "react";

/** Narrowest width the Sidebar may be dragged to. */
export const SIDEBAR_MIN_WIDTH = 160;
/** Widest width the Sidebar may be dragged to. */
export const SIDEBAR_MAX_WIDTH = 640;

/** Constrains a requested Sidebar width to the supported range. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SIDEBAR_MIN_WIDTH;
  }
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

export interface SidebarProps {
  /** Current width in CSS pixels. */
  width: number;
  /** Reports a dragged width, already clamped by the caller. */
  onResize(width: number): void;
  /** Accessible name for the panel; supplied by whichever view is hosted. */
  label: string;
  /** The hosted view. */
  children: ReactNode;
}

/**
 * Renders the Sidebar with a draggable right edge.
 *
 * Dragging is tracked on the window rather than on the divider so the pointer
 * may leave the thin divider without losing the drag.
 */
export function Sidebar({ width, onResize, label, children }: SidebarProps) {
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(
    null,
  );

  useEffect(() => {
    if (drag === null) {
      return;
    }

    const onMove = (event: PointerEvent): void => {
      onResize(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
    };
    const onEnd = (): void => {
      setDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [drag, onResize]);

  return (
    <div className="sidebar" style={{ width: `${width}px` }}>
      <div className="sidebar__content" role="complementary" aria-label={label}>
        {children}
      </div>
      <div
        className={
          drag === null ? "sidebar__resizer" : "sidebar__resizer sidebar__resizer--active"
        }
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(event) => {
          event.preventDefault();
          setDrag({ startX: event.clientX, startWidth: width });
        }}
      />
    </div>
  );
}
