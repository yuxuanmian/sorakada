/**
 * The application shell layout.
 *
 * `AppShell` is composition, not a framework: a Header, a Body, and inside the
 * Body a generic Sidebar next to the Editor Area. It owns the shell's *layout
 * model* — the transient Sidebar visibility/width state and its bounds — while
 * the state itself lives in `App`, which also has to toggle it from the View
 * menu (FR-090, FR-092, FR-093).
 */

import type { ReactNode } from "react";
import {
  clampSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  Sidebar,
} from "./Sidebar";

import "../../styles/shell.css";

export { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, clampSidebarWidth };

/** The transient shell layout state. Never persisted in 003. */
export interface UiLayoutState {
  /** Whether the Sidebar is shown. */
  sidebarVisible: boolean;
  /** Sidebar width in CSS pixels. */
  sidebarWidth: number;
}

/** The layout a launch starts with. */
export const DEFAULT_UI_LAYOUT: UiLayoutState = {
  sidebarVisible: true,
  sidebarWidth: 260,
};

export interface AppShellProps {
  /** Sidebar content, or `null` when the Sidebar is hidden. */
  sidebar: ReactNode;
  /** The Editor Area: TabBar plus EditorHost or Empty State. */
  editorArea: ReactNode;
  /** Whether the Sidebar is currently shown (FR-092). */
  sidebarVisible: boolean;
  /** Current Sidebar width. */
  sidebarWidth: number;
  /** Reports a dragged Sidebar width. */
  onSidebarWidthChange(width: number): void;
}

/**
 * Renders the shell.
 *
 * Hiding the Sidebar keeps its content mounted nowhere and removes it from the
 * layout, while the Editor Area keeps whatever document/Explorer state the
 * application owns — nothing here holds document state of its own.
 */
export function AppShell({
  sidebar,
  editorArea,
  sidebarVisible,
  sidebarWidth,
  onSidebarWidthChange,
}: AppShellProps) {
  return (
    <div className="app">
      <header className="app__header">
        <span className="app__wordmark">Sorakada</span>
      </header>

      <div className="app__body">
        {sidebarVisible ? (
          <Sidebar
            width={clampSidebarWidth(sidebarWidth)}
            onResize={onSidebarWidthChange}
            label="Explorer"
          >
            {sidebar}
          </Sidebar>
        ) : null}

        <main className="editor-area">{editorArea}</main>
      </div>
    </div>
  );
}
