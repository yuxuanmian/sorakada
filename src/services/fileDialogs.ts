import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import type { OperationErrorContext } from "./errorContext";
import { dialogManager, type DialogValidity } from "../ui/dialog/dialogManager";
import { notificationManager } from "../ui/notification/notificationManager";

export type UnsavedChoice = "save" | "dontSave" | "cancel";
export type ExternalConflictChoice = "overwrite" | "cancel";
export interface FileDialogService {
  pickOpenPath(): Promise<string | null>;
  pickSavePath(currentPath: string | null): Promise<string | null>;
  showError(text: string, context?: OperationErrorContext): Promise<void>;
  clearError?(context: OperationErrorContext): void;
  confirmUnsavedChanges(displayName: string, validity?: DialogValidity): Promise<UnsavedChoice>;
  confirmExternalOverwrite(displayName: string, validity?: DialogValidity): Promise<ExternalConflictChoice>;
  confirmDiscardForReload(displayName: string, validity?: DialogValidity): Promise<boolean>;
}

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

const filters = () => [
  { name: t("dialogs.textFiles"), extensions: TEXT_FILE_EXTENSIONS },
  { name: t("dialogs.allFiles"), extensions: ["*"] },
];
const cancel = { value: "cancel", label: () => t("dialogs.cancel") };

/** Native pickers and application-owned decisions share the old stable result contract. */
export const nativeFileDialogService: FileDialogService = {
  async pickOpenPath() {
    const selected = await open({ title: t("dialogs.openFile"), multiple: false, directory: false, filters: filters() });
    return typeof selected === "string" ? selected : null;
  },
  async pickSavePath(currentPath) {
    return (await save({ title: t("dialogs.saveAs"), filters: filters(), ...(currentPath === null ? {} : { defaultPath: currentPath }) })) ?? null;
  },
  async showError(text, context) { notificationManager.report(text, context); },
  clearError(context) { notificationManager.resolve(context); },
  async confirmUnsavedChanges(name, validity) {
    return await dialogManager.request({ title: () => t("dialogs.title"), message: () => t("dialogs.unsaved", { name }), validity, cancelValue: "cancel",
      buttons: [{ value: "save", label: () => t("dialogs.save") }, { value: "dontSave", label: () => t("dialogs.dontSave"), dangerous: true }, cancel],
    }) as UnsavedChoice;
  },
  async confirmExternalOverwrite(name, validity) {
    return await dialogManager.request({ title: () => t("dialogs.title"), message: () => t("dialogs.external", { name }), validity, cancelValue: "cancel",
      buttons: [{ value: "overwrite", label: () => t("dialogs.overwrite"), dangerous: true }, cancel],
    }) as ExternalConflictChoice;
  },
  async confirmDiscardForReload(name, validity) {
    return (await dialogManager.request({ title: () => t("dialogs.title"), message: () => t("dialogs.reload", { name }), validity, cancelValue: "cancel",
      buttons: [{ value: "discard", label: () => t("dialogs.discard"), dangerous: true }, cancel],
    })) === "discard";
  },
};
