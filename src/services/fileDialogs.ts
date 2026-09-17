import { message, open, save } from "@tauri-apps/plugin-dialog";

/** The user's decision when unsaved work is about to be discarded. */
export type UnsavedChoice = "save" | "dontSave" | "cancel";

/** The native dialogs the document lifecycle depends on. */
export interface FileDialogService {
  /**
   * Asks for a file to open.
   *
   * Resolves `null` when the user cancels, which callers must treat as "leave
   * the current document exactly as it is".
   */
  pickOpenPath(): Promise<string | null>;
  /**
   * Asks where to write the document.
   *
   * `currentPath` prefills the dialog for an already-associated document.
   * Resolves `null` when the user cancels.
   */
  pickSavePath(currentPath: string | null): Promise<string | null>;
  /** Reports a failure the user needs to see. */
  showError(text: string): Promise<void>;
  /**
   * Three-way prompt shown before a dirty document is closed or before the
   * application window exits.
   *
   * New and Open are multi-document operations in 002: they add or activate a
   * document without discarding the current one, so they never run this guard.
   */
  confirmUnsavedChanges(displayName: string): Promise<UnsavedChoice>;
}

/** Extensions offered by the native pickers; "All files" always remains available. */
export const TEXT_FILE_EXTENSIONS = [
  "txt",
  "text",
  "md",
  "markdown",
  "json",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "html",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "csv",
  "sh",
  "ps1",
  "bat",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
];

const DIALOG_FILTERS = [
  { name: "Text files", extensions: TEXT_FILE_EXTENSIONS },
  { name: "All files", extensions: ["*"] },
];

const APP_DIALOG_TITLE = "Sorakada";

/**
 * The labels of the three-button unsaved-work prompt.
 *
 * Kept in one place because these exact strings are what the native dialog
 * hands back: see `toUnsavedChoice`. The prompt is used only by Tab close and
 * window exit.
 */
export const UNSAVED_WORK_BUTTONS = {
  save: "Save",
  dontSave: "Don't Save",
  cancel: "Cancel",
} as const;

/**
 * Maps a message-dialog result onto the guard's decision.
 *
 * `tauri-plugin-dialog` does **not** return the `Yes` / `No` / `Cancel` role
 * names for custom buttons. On desktop it rewrites rfd's `Yes`/`No`/`Cancel`
 * into `Custom(<the configured label>)` (`src/desktop.rs`), and
 * `MessageDialogResult::Custom(String)` is `#[serde(untagged)]`
 * (`src/models.rs`), so the value crossing the IPC boundary is the bare label
 * string — `"Save"`, `"Don't Save"` or `"Cancel"`.
 *
 * The role names are still accepted so the mapping survives a platform that
 * falls back to the OS default button texts. Anything else (including a
 * dismissed dialog) is treated as "cancel", which is the safe outcome: it
 * keeps the current document.
 */
export function toUnsavedChoice(result: string): UnsavedChoice {
  if (result === UNSAVED_WORK_BUTTONS.save || result === "Yes") {
    return "save";
  }
  if (result === UNSAVED_WORK_BUTTONS.dontSave || result === "No") {
    return "dontSave";
  }
  return "cancel";
}

/** The native dialog implementation used by the desktop application. */
export const nativeFileDialogService: FileDialogService = {
  async pickOpenPath(): Promise<string | null> {
    const selected = await open({
      title: "Open File",
      multiple: false,
      directory: false,
      filters: DIALOG_FILTERS,
    });

    return typeof selected === "string" ? selected : null;
  },

  async pickSavePath(currentPath: string | null): Promise<string | null> {
    const selected = await save({
      title: "Save As",
      filters: DIALOG_FILTERS,
      ...(currentPath === null ? {} : { defaultPath: currentPath }),
    });

    return selected ?? null;
  },

  async showError(text: string): Promise<void> {
    await message(text, { title: APP_DIALOG_TITLE, kind: "error" });
  },

  async confirmUnsavedChanges(displayName: string): Promise<UnsavedChoice> {
    const result = await message(`Save changes to ${displayName}?`, {
      title: APP_DIALOG_TITLE,
      kind: "warning",
      buttons: {
        yes: UNSAVED_WORK_BUTTONS.save,
        no: UNSAVED_WORK_BUTTONS.dontSave,
        cancel: UNSAVED_WORK_BUTTONS.cancel,
      },
    });

    return toUnsavedChoice(result);
  },
};
