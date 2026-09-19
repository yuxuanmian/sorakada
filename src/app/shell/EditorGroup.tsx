/**
 * The Editor Group composition boundary (007 T048, FR-002, FR-061..FR-063).
 *
 * A group owns its own Tab strip and its own editor host. In 007 there is exactly
 * one group, no group id, no group manager and no second CodeMirror view: this is
 * a *structural* seam that stops the Tab strip from being an AppShell singleton,
 * which is what later split-editor work would otherwise have to undo first.
 */

import type { ReactNode } from "react";

export interface EditorGroupProps {
  /** The group's own Tab strip, or nothing when the group is unadorned. */
  tabStrip?: ReactNode;
  /** Editor host or Empty State. */
  children: ReactNode;
}

/** Renders one editor group. */
export function EditorGroup({ tabStrip, children }: EditorGroupProps) {
  return (
    <section className="editor-group" aria-label="Editor group">
      {tabStrip}
      <div className="editor-group__host">{children}</div>
    </section>
  );
}
