/**
 * The Sidebar container.
 *
 * It is a *generic* horizontal panel: 007 puts the Explorer in it, but nothing
 * here is Explorer-specific (FR-026). Width and visibility are owned by
 * `UiPreferencesStore`; this component only renders the width it is given and
 * reports drag requests.
 *
 * The Sidebar deliberately does **not** clamp: the bounds are a property of the
 * MainArea, and `AppShell`/`layoutMetrics` own them. A drag therefore reports the
 * raw request, and rendering decides how much of it fits (FR-084).
 */

import { useEffect, useState, type ReactNode } from "react";

export interface SidebarProps {
  /** Rendered width in CSS logical pixels, already clamped by the caller. */
  width: number;
  /** Reports a dragged width request; the caller clamps and stores it. */
  onResize(requestedWidth: number): void;
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
      onResize(drag.startWidth + event.clientX - drag.startX);
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
        data-sora-interactive=""
        onPointerDown={(event) => {
          event.preventDefault();
          setDrag({ startX: event.clientX, startWidth: width });
        }}
      />
    </div>
  );
}
