import { message, open, save } from "@tauri-apps/plugin-dialog";

/** The user's decision when unsaved work is about to be discarded. */
export type UnsavedChoice = "save" | "dontSave" | "cancel";

/**
 * The user's decision when ordinary Save met an externally changed file.
 *
 * 005 exposes exactly these two outcomes and no merge/diff middle ground
 * (FR-023, FR-024, FR-042).
 */
export type ExternalConflictChoice = "overwrite" | "cancel";

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
  /**
   * The explicit overwrite decision ordinary Save must obtain when the bound
   * file changed on disk while the document was dirty (FR-023, FR-042).
   *
   * Anything other than a positive Overwrite answer resolves `cancel`, which is
   * the safe outcome: it leaves both the buffer and the disk untouched.
   */
  confirmExternalOverwrite(displayName: string): Promise<ExternalConflictChoice>;
  /**
   * Confirms that unsaved changes may be discarded because validated disk
   * content is about to replace them (FR-027).
   *
   * Only a positive answer resolves `true`.
   */
  confirmDiscardForReload(displayName: string): Promise<boolean>;
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

/**
 * The labels of the external-conflict prompt.
 *
 * `Overwrite` is deliberately not labelled `Yes`/`Save`: FR-042 requires the
 * decision to read as an explicit overwrite rather than as an ordinary save.
 */
export const EXTERNAL_CONFLICT_BUTTONS = {
  overwrite: "Overwrite",
  cancel: "Cancel",
} as const;

/** The labels of the discard-and-reload prompt (FR-027). */
export const DISCARD_RELOAD_BUTTONS = {
  discard: "Discard",
  cancel: "Cancel",
} as const;

/**
 * Maps a message-dialog result onto the overwrite decision.
 *
 * Like `toUnsavedChoice` this accepts both the configured label and the
 * platform's role name, and treats everything else — including a dismissed
 * dialog — as Cancel (FR-024).
 */
export function toExternalConflictChoice(result: string): ExternalConflictChoice {
  if (
    result === EXTERNAL_CONFLICT_BUTTONS.overwrite ||
    result === "Yes" ||
    result === "Ok"
  ) {
    return "overwrite";
  }
  return "cancel";
}

/** Maps a message-dialog result onto the discard confirmation (FR-027). */
export function toDiscardChoice(result: string): boolean {
  return (
    result === DISCARD_RELOAD_BUTTONS.discard ||
    result === "Yes" ||
    result === "Ok"
  );
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

  async confirmExternalOverwrite(
    displayName: string,
  ): Promise<ExternalConflictChoice> {
    const result = await message(
      `${displayName} has changed on disk since Sorakada read it. Overwrite the file on disk with the version open in Sorakada?`,
      {
        title: APP_DIALOG_TITLE,
        kind: "warning",
        // `Ok`/`Cancel` is the two-button shape the plugin accepts; the labels are
        // what the platform hands back, which is why the mapping above accepts the
        // role names as well.
        buttons: {
          ok: EXTERNAL_CONFLICT_BUTTONS.overwrite,
          cancel: EXTERNAL_CONFLICT_BUTTONS.cancel,
        },
      },
    );

    return toExternalConflictChoice(result);
  },

  async confirmDiscardForReload(displayName: string): Promise<boolean> {
    const result = await message(
      `Reload ${displayName} from disk and discard the unsaved changes in Sorakada?`,
      {
        title: APP_DIALOG_TITLE,
        kind: "warning",
        buttons: {
          ok: DISCARD_RELOAD_BUTTONS.discard,
          cancel: DISCARD_RELOAD_BUTTONS.cancel,
        },
      },
    );

    return toDiscardChoice(result);
  },
};
