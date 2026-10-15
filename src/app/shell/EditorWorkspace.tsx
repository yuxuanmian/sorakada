/**
 * The content-side shell boundary (007 T047, FR-002).
 *
 * `EditorWorkspace` is where editor groups live. In 007 there is exactly one, and
 * this component owns no document state at all: it exists so the AppShell stops
 * assuming a global Tab strip and so a later split layout has a seam to grow into
 * without moving Tab ownership first.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface EditorWorkspaceProps {
  /** The editor group(s) hosted by the workspace. */
  children: ReactNode;
}

/** Renders the Editor Workspace region. */
export function EditorWorkspace({ children }: EditorWorkspaceProps) {
  const { t } = useTranslation();
  return (
    <main className="editor-workspace" aria-label={t("ui.editorWorkspace.region")}>
      {children}
    </main>
  );
}
