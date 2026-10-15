import { beforeEach, describe, expect, it, vi } from "vitest";

const { openMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
}));

import {
  deleteConfirmationText,
  nativeWorkspaceDialogService,
} from "./workspaceDialogs";
import { dialogManager } from "../ui/dialog/dialogManager";
import { notificationManager } from "../ui/notification/notificationManager";

beforeEach(() => {
  openMock.mockReset();
  dialogManager.cancelAll();
});

describe("deleteConfirmationText", () => {
  it("formats clean target message", () => {
    const text = deleteConfirmationText({
      displayName: "doc.txt",
      dirty: false,
      affectedDirtyNames: [],
    });
    expect(text).toContain("doc.txt");
  });

  it("warns about unsaved changes when target is dirty", () => {
    const text = deleteConfirmationText({
      displayName: "doc.txt",
      dirty: true,
      affectedDirtyNames: [],
    });
    expect(text).toContain("doc.txt");
  });

  it("names affected dirty children", () => {
    const text = deleteConfirmationText({
      displayName: "src",
      dirty: false,
      affectedDirtyNames: ["a.ts", "b.ts"],
    });
    expect(text).toContain("src");
    expect(text).toContain("a.ts, b.ts");
  });
});

describe("nativeWorkspaceDialogService.pickWorkspaceFolder", () => {
  it("opens a directory-only picker and returns the path", async () => {
    openMock.mockResolvedValue("C:\\projects\\repo");
    await expect(nativeWorkspaceDialogService.pickWorkspaceFolder()).resolves.toBe(
      "C:\\projects\\repo"
    );
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        directory: true,
      })
    );
  });

  it("returns null when dismissed", async () => {
    openMock.mockResolvedValue(null);
    await expect(nativeWorkspaceDialogService.pickWorkspaceFolder()).resolves.toBeNull();
  });
});

describe("nativeWorkspaceDialogService.confirmDelete", () => {
  it("resolves true when delete chosen, false on cancel", async () => {
    const detach = dialogManager.attach();
    try {
      const pDelete = nativeWorkspaceDialogService.confirmDelete({
        displayName: "foo.txt",
        dirty: false,
        affectedDirtyNames: [],
      });
      expect(dialogManager.getSnapshot()?.buttons.map(b => b.value)).toEqual(["delete", "cancel"]);
      dialogManager.choose(dialogManager.getSnapshot()!.id, "delete");
      await expect(pDelete).resolves.toBe(true);

      const pCancel = nativeWorkspaceDialogService.confirmDelete({
        displayName: "bar.txt",
        dirty: false,
        affectedDirtyNames: [],
      });
      dialogManager.choose(dialogManager.getSnapshot()!.id, "cancel");
      await expect(pCancel).resolves.toBe(false);
    } finally {
      detach();
    }
  });

  it("resolves false when request validity is false", async () => {
    const detach = dialogManager.attach();
    try {
      let valid = true;
      const p = nativeWorkspaceDialogService.confirmDelete(
        { displayName: "baz.txt", dirty: true, affectedDirtyNames: [] },
        { isValid: () => valid }
      );
      valid = false;
      dialogManager.choose(dialogManager.getSnapshot()!.id, "delete");
      await expect(p).resolves.toBe(false);
    } finally {
      detach();
    }
  });
});

describe("nativeWorkspaceDialogService.showError", () => {
  it("delegates to notificationManager synchronously", async () => {
    const reportSpy = vi.spyOn(notificationManager, "report");
    await nativeWorkspaceDialogService.showError("Failed to remove", { operation: "delete" });
    expect(reportSpy).toHaveBeenCalledWith("Failed to remove", { operation: "delete" });
    reportSpy.mockRestore();
  });

  it("delegates clearError to notificationManager.resolve", () => {
    const resolveSpy = vi.spyOn(notificationManager, "resolve");
    nativeWorkspaceDialogService.clearError?.({ operation: "workspace", path: "C:\\projects\\repo" });
    expect(resolveSpy).toHaveBeenCalledWith({ operation: "workspace", path: "C:\\projects\\repo" });
    resolveSpy.mockRestore();
  });
});
