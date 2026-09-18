import { message, open } from "@tauri-apps/plugin-dialog";

/**
 * Workspace-level native dialogs.
 *
 * 003 adds two dialogs the 002 document dialogs do not cover: choosing a
 * Workspace folder, and confirming that an Explorer entry may be moved to the
 * operating system's recycle bin. The confirmation *text* is a pure function so
 * the required dirty-work warning (FR-069) is pinned by tests rather than by a
 * manual reading of the dialog code.
 */

/** What the Delete confirmation has to warn about. */
export interface DeleteConfirmationRequest {
  /** Display name of the entry being deleted. */
  displayName: string;
  /** Whether the target itself is an open document with unsaved changes. */
  dirty: boolean;
  /**
   * Display names of open documents with unsaved changes *inside* the target
   * directory. Always empty for a file target.
   */
  affectedDirtyNames: readonly string[];
}

/** The native dialogs the Workspace and Explorer depend on. */
export interface WorkspaceDialogService {
  /** Asks for a folder to use as the Workspace; `null` means cancelled. */
  pickWorkspaceFolder(): Promise<string | null>;
  /** Reports a failure the user needs to see. */
  showError(text: string): Promise<void>;
  /**
   * Confirms moving `displayName` to the OS recycle bin.
   *
   * Only `true` lets the caller perform the destructive operation, so a
   * dismissed dialog is a cancellation rather than a confirmation.
   */
  confirmDelete(request: DeleteConfirmationRequest): Promise<boolean>;
}

const APP_DIALOG_TITLE = "Sorakada";

/** The two-button labels of the Delete confirmation. */
export const DELETE_BUTTONS = {
  delete: "Delete",
  cancel: "Cancel",
} as const;

/** Quotes a display name so the dialog text stays unambiguous. */
function quoted(name: string): string {
  return `"${name}"`;
}

/**
 * Builds the Delete confirmation text.
 *
 * A target with unsaved open work gets an explicit warning that those changes
 * will be lost (FR-069); a clean target gets the plain recoverable-delete
 * wording. Untitled documents can never be affected, because they have no disk
 * path and therefore no place under the target.
 */
export function deleteConfirmationText(
  request: DeleteConfirmationRequest,
): string {
  const base = `Move ${quoted(request.displayName)} to the Recycle Bin?`;

  if (request.affectedDirtyNames.length === 0) {
    return request.dirty
      ? `${base} Its unsaved changes will be lost.`
      : base;
  }

  const names = request.affectedDirtyNames.map(quoted).join(", ");
  return `${base} Unsaved changes in ${names} will be lost.`;
}

/**
 * Maps a message-dialog result onto the Delete decision.
 *
 * Like the 002 unsaved-work prompt, `tauri-plugin-dialog` hands back the
 * configured button *label* rather than a role name for a custom button, so the
 * label and the platform role spellings are both accepted. Anything else —
 * including a dismissed dialog — is a cancellation, which is the safe outcome.
 */
export function toDeleteConfirmed(result: string): boolean {
  return (
    result === DELETE_BUTTONS.delete || result === "Ok" || result === "Yes"
  );
}

/** The native dialog implementation used by the desktop application. */
export const nativeWorkspaceDialogService: WorkspaceDialogService = {
  async pickWorkspaceFolder(): Promise<string | null> {
    const selected = await open({
      title: "Open Folder",
      multiple: false,
      directory: true,
    });

    return typeof selected === "string" ? selected : null;
  },

  async showError(text: string): Promise<void> {
    await message(text, { title: APP_DIALOG_TITLE, kind: "error" });
  },

  async confirmDelete(request: DeleteConfirmationRequest): Promise<boolean> {
    const result = await message(deleteConfirmationText(request), {
      title: APP_DIALOG_TITLE,
      kind: "warning",
      buttons: {
        ok: DELETE_BUTTONS.delete,
        cancel: DELETE_BUTTONS.cancel,
      },
    });

    return toDeleteConfirmed(result);
  },
};
