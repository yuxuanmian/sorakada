/**
 * The application shell layout (007 T050, T052, T054, T152).
 *
 * `AppShell` is composition, not a framework:
 *
 * ```text
 * AppShell
 * ├── TopBar
 * ├── MainArea
 * │   ├── Sidebar
 * │   └── EditorWorkspace (EditorGroup -> TabStrip + EditorHost)
 * └── FooterBar
 * ```
 *
 * It owns the *layout* facts — Sidebar visibility, the user's preferred Sidebar
 * width, and the measurement that turns that preference into a rendered width —
 * while the persisted preference itself lives in `UiPreferencesStore` (FR-085) and
 * document/Workspace/Explorer state stays with its own owners.
 *
 * The MainArea is measured with a `ResizeObserver`, so the Sidebar bound is
 * recomputed when the window is resized *or* moved to a display with a different
 * logical viewport (FR-084, T152). The measurement only ever clamps what is
 * *rendered*; the preference keeps the user's number (T153, T161).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { renderSidebarWidth } from "./layoutMetrics";
import { Sidebar } from "./Sidebar";

import "../../styles/shell.css";

export interface AppShellProps {
  /** The window-level region. */
  topBar: ReactNode;
  /** Explorer (or another tool view) content, or `null` when hidden. */
  sidebar: ReactNode;
  /** The Editor Workspace. */
  editor: ReactNode;
  /** The application Footer. */
  footer: ReactNode;
  /** Whether the Sidebar region is shown (FR-085). */
  sidebarVisible: boolean;
  /** The user's preferred Sidebar width in CSS logical pixels. */
  sidebarWidth: number;
  /**
   * Reports a dragged Sidebar width.
   *
   * The value is the *request*, not the rendered width: the preference owner
   * stores what the user asked for and rendering applies the layout clamp.
   */
  onSidebarWidthChange(requestedWidth: number): void;
}

/** Renders the shell. */
export function AppShell({
  topBar,
  sidebar,
  editor,
  footer,
  sidebarVisible,
  sidebarWidth,
  onSidebarWidthChange,
}: AppShellProps) {
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const [mainAreaWidth, setMainAreaWidth] = useState(0);

  useEffect(() => {
    const element = mainAreaRef.current;
    if (element === null) {
      return;
    }

    const measure = (): void => {
      setMainAreaWidth(element.clientWidth);
    };
    measure();

    // `ResizeObserver` is the primary signal because it also fires when the
    // WebView's logical viewport changes without a window resize event (a DPI or
    // monitor change). The window listener is only a fallback for a runtime that
    // does not provide it.
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  /*
   * Before the first measurement the layout bound is unknown. Rendering the
   * preferred width then is the only answer that cannot be wrong, because a
   * bound computed from "0 available pixels" would briefly force the minimum.
   */
  const renderedSidebarWidth =
    mainAreaWidth === 0
      ? sidebarWidth
      : renderSidebarWidth(sidebarWidth, mainAreaWidth);

  return (
    <div className="app">
      {topBar}

      <div className="app__main-area" ref={mainAreaRef}>
        {sidebarVisible ? (
          <Sidebar
            width={renderedSidebarWidth}
            onResize={onSidebarWidthChange}
            label="Explorer"
          >
            {sidebar}
          </Sidebar>
        ) : null}

        {editor}
      </div>

      {footer}
    </div>
  );
}
