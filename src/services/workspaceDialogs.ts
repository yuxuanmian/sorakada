import { open } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import type { OperationErrorContext } from "./errorContext";
import { dialogManager, type DialogValidity } from "../ui/dialog/dialogManager";
import { notificationManager } from "../ui/notification/notificationManager";

export interface DeleteConfirmationRequest {
  displayName: string;
  dirty: boolean;
  affectedDirtyNames: readonly string[];
}
export interface WorkspaceDialogService {
  pickWorkspaceFolder(): Promise<string | null>;
  showError(text: string, context?: OperationErrorContext): Promise<void>;
  clearError?(context: OperationErrorContext): void;
  confirmDelete(request: DeleteConfirmationRequest, validity?: DialogValidity): Promise<boolean>;
}
export function deleteConfirmationText(request: DeleteConfirmationRequest): string {
  const base = t("dialogs.trash", { name: request.displayName });
  if (request.affectedDirtyNames.length) return `${base} ${t("dialogs.dirtyChildren", { names: request.affectedDirtyNames.join(", ") })}`;
  return request.dirty ? `${base} ${t("dialogs.dirtyTarget")}` : base;
}
export const nativeWorkspaceDialogService: WorkspaceDialogService = {
  async pickWorkspaceFolder() {
    const selected = await open({ title: t("dialogs.openFolder"), multiple: false, directory: true });
    return typeof selected === "string" ? selected : null;
  },
  async showError(text, context) { notificationManager.report(text, context); },
  clearError(context) { notificationManager.resolve(context); },
  async confirmDelete(request, validity) {
    return (await dialogManager.request({ title: () => t("dialogs.title"), message: () => deleteConfirmationText(request), validity, cancelValue: "cancel",
      buttons: [{ value: "delete", label: () => t("dialogs.delete"), dangerous: true }, { value: "cancel", label: () => t("dialogs.cancel") }],
    })) === "delete";
  },
};
