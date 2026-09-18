/**
 * The Editor Area's zero-document state.
 *
 * 003 makes "no open document" a real, permanent state (FR-012, FR-016), so it
 * gets real UI instead of a hidden placeholder document. It is deliberately not
 * represented in the document model: it is a view of "there is nothing to show",
 * and both of its actions go through the ordinary Open File / Open Folder paths.
 */

export interface EmptyStateProps {
  /** Display name of the active Workspace, or `null` when none is open. */
  workspaceName: string | null;
  /** Opens a file through the ordinary document pipeline. */
  onOpenFile(): void;
  /** Opens a folder as the Workspace. */
  onOpenFolder(): void;
}

/** Renders the Empty State shown while no document is active. */
export function EmptyState({
  workspaceName,
  onOpenFile,
  onOpenFolder,
}: EmptyStateProps) {
  return (
    <div className="empty-state" role="status">
      <p className="empty-state__title">No file is open</p>
      <p className="empty-state__hint">
        {workspaceName === null
          ? "Open a file to start editing, or open a folder to browse a Workspace."
          : `Open a file to start editing. ${workspaceName} stays open in the Explorer.`}
      </p>
      <div className="empty-state__actions">
        <button type="button" className="shell-button" onClick={onOpenFile}>
          Open File
        </button>
        <button type="button" className="shell-button" onClick={onOpenFolder}>
          Open Folder
        </button>
      </div>
    </div>
  );
}
