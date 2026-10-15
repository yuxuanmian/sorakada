import { beforeEach, describe, expect, it, vi } from "vitest";

const { openMock, saveMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
  save: saveMock,
}));

import { nativeFileDialogService } from "./fileDialogs";
import { dialogManager } from "../ui/dialog/dialogManager";
import { notificationManager } from "../ui/notification/notificationManager";

beforeEach(() => {
  openMock.mockReset();
  saveMock.mockReset();
  dialogManager.cancelAll();
});

describe("nativeFileDialogService - native pickers", () => {
  it("pickOpenPath opens native picker and returns chosen file", async () => {
    openMock.mockResolvedValue("C:\\work\\notes.txt");
    await expect(nativeFileDialogService.pickOpenPath()).resolves.toBe("C:\\work\\notes.txt");
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        directory: false,
      })
    );
  });

  it("pickOpenPath returns null when dismissed", async () => {
    openMock.mockResolvedValue(null);
    await expect(nativeFileDialogService.pickOpenPath()).resolves.toBeNull();
  });

  it("pickSavePath prefills defaultPath when given", async () => {
    saveMock.mockResolvedValue("C:\\work\\copy.txt");
    await expect(nativeFileDialogService.pickSavePath("C:\\work\\notes.txt")).resolves.toBe("C:\\work\\copy.txt");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "C:\\work\\notes.txt",
      })
    );
  });

  it("pickSavePath omits defaultPath for null", async () => {
    saveMock.mockResolvedValue(null);
    await expect(nativeFileDialogService.pickSavePath(null)).resolves.toBeNull();
    const opts = saveMock.mock.calls[0][0] as Record<string, unknown>;
    expect("defaultPath" in opts).toBe(false);
  });
});

describe("nativeFileDialogService - custom confirmations via dialogManager", () => {
  it("confirmUnsavedChanges maps user choice and safe cancel", async () => {
    const detach = dialogManager.attach();
    try {
      const pSave = nativeFileDialogService.confirmUnsavedChanges("a.txt");
      expect(dialogManager.getSnapshot()?.buttons.map(b => b.value)).toEqual(["save", "dontSave", "cancel"]);
      dialogManager.choose(dialogManager.getSnapshot()!.id, "save");
      await expect(pSave).resolves.toBe("save");

      const pDontSave = nativeFileDialogService.confirmUnsavedChanges("b.txt");
      dialogManager.choose(dialogManager.getSnapshot()!.id, "dontSave");
      await expect(pDontSave).resolves.toBe("dontSave");

      const pCancel = nativeFileDialogService.confirmUnsavedChanges("c.txt");
      dialogManager.choose(dialogManager.getSnapshot()!.id, "cancel");
      await expect(pCancel).resolves.toBe("cancel");
    } finally {
      detach();
    }
  });

  it("confirmUnsavedChanges returns cancel when invalid", async () => {
    const detach = dialogManager.attach();
    try {
      let valid = true;
      const p = nativeFileDialogService.confirmUnsavedChanges("a.txt", { isValid: () => valid });
      valid = false;
      dialogManager.choose(dialogManager.getSnapshot()!.id, "save");
      await expect(p).resolves.toBe("cancel");
    } finally {
      detach();
    }
  });

  it("confirmExternalOverwrite resolves overwrite or cancel", async () => {
    const detach = dialogManager.attach();
    try {
      const pOverwrite = nativeFileDialogService.confirmExternalOverwrite("a.txt");
      dialogManager.choose(dialogManager.getSnapshot()!.id, "overwrite");
      await expect(pOverwrite).resolves.toBe("overwrite");

      const pCancel = nativeFileDialogService.confirmExternalOverwrite("a.txt");
      dialogManager.choose(dialogManager.getSnapshot()!.id, "cancel");
      await expect(pCancel).resolves.toBe("cancel");
    } finally {
      detach();
    }
  });

  it("confirmDiscardForReload resolves boolean with safe false", async () => {
    const detach = dialogManager.attach();
    try {
      const pDiscard = nativeFileDialogService.confirmDiscardForReload("a.txt");
      dialogManager.choose(dialogManager.getSnapshot()!.id, "discard");
      await expect(pDiscard).resolves.toBe(true);

      const pCancel = nativeFileDialogService.confirmDiscardForReload("a.txt");
      dialogManager.choose(dialogManager.getSnapshot()!.id, "cancel");
      await expect(pCancel).resolves.toBe(false);
    } finally {
      detach();
    }
  });
});

describe("nativeFileDialogService - error reporting & clearing", () => {
  it("showError and clearError delegate to notificationManager synchronously", async () => {
    const reportSpy = vi.spyOn(notificationManager, "report");
    const resolveSpy = vi.spyOn(notificationManager, "resolve");

    await nativeFileDialogService.showError("Save failed", { operation: "save", documentId: "doc-1" });
    expect(reportSpy).toHaveBeenCalledWith("Save failed", { operation: "save", documentId: "doc-1" });

    nativeFileDialogService.clearError?.({ operation: "save", documentId: "doc-1" });
    expect(resolveSpy).toHaveBeenCalledWith({ operation: "save", documentId: "doc-1" });

    reportSpy.mockRestore();
    resolveSpy.mockRestore();
  });
});
