import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DELETE_BUTTONS,
  deleteConfirmationText,
  nativeWorkspaceDialogService,
  toDeleteConfirmed,
} from "./workspaceDialogs";

/**
 * `@tauri-apps/plugin-dialog` is mocked so the native dialog options and the
 * result mapping can be asserted without a desktop shell.
 */
const { messageMock, openMock } = vi.hoisted(() => ({
  messageMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: messageMock,
  open: openMock,
}));

beforeEach(() => {
  messageMock.mockReset();
  openMock.mockReset();
});

describe("deleteConfirmationText (FR-068, FR-069)", () => {
  it("asks a plain recoverable question for a clean target", () => {
    const text = deleteConfirmationText({
      displayName: "a.txt",
      dirty: false,
      affectedDirtyNames: [],
    });

    expect(text).toBe('Move "a.txt" to the Recycle Bin?');
    // The wording must never suggest a permanent delete.
    expect(text).not.toMatch(/permanently|permanent/i);
  });

  it("warns explicitly when the target itself has unsaved changes", () => {
    const text = deleteConfirmationText({
      displayName: "a.txt",
      dirty: true,
      affectedDirtyNames: [],
    });

    expect(text).toBe(
      'Move "a.txt" to the Recycle Bin? Its unsaved changes will be lost.',
    );
  });

  it("names the unsaved open documents inside a directory target", () => {
    const text = deleteConfirmationText({
      displayName: "src",
      dirty: false,
      affectedDirtyNames: ["a.ts", "nested/b.ts"],
    });

    expect(text).toBe(
      'Move "src" to the Recycle Bin? Unsaved changes in "a.ts", "nested/b.ts" will be lost.',
    );
  });

  it("keeps the discard warning when only some documents are dirty", () => {
    const text = deleteConfirmationText({
      displayName: "src",
      dirty: false,
      affectedDirtyNames: ["a.ts"],
    });

    expect(text).toContain("Unsaved changes");
    expect(text).toContain('"a.ts"');
  });
});

describe("toDeleteConfirmed (FR-070)", () => {
  it("confirms only for the Delete label or the platform ok/yes roles", () => {
    expect(toDeleteConfirmed(DELETE_BUTTONS.delete)).toBe(true);
    expect(toDeleteConfirmed("Ok")).toBe(true);
    expect(toDeleteConfirmed("Yes")).toBe(true);
  });

  it("treats Cancel and anything unexpected as a cancellation", () => {
    expect(toDeleteConfirmed(DELETE_BUTTONS.cancel)).toBe(false);
    expect(toDeleteConfirmed("No")).toBe(false);
    expect(toDeleteConfirmed("")).toBe(false);
    expect(toDeleteConfirmed("something else")).toBe(false);
  });
});

describe("nativeWorkspaceDialogService.pickWorkspaceFolder (US1)", () => {
  it("opens a directory-only picker and returns the chosen path", async () => {
    openMock.mockResolvedValue("C:\\work");

    await expect(
      nativeWorkspaceDialogService.pickWorkspaceFolder(),
    ).resolves.toBe("C:\\work");

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith({
      title: "Open Folder",
      multiple: false,
      directory: true,
    });
  });

  it("reports a dismissed picker as null", async () => {
    openMock.mockResolvedValue(null);

    await expect(
      nativeWorkspaceDialogService.pickWorkspaceFolder(),
    ).resolves.toBeNull();
  });
});

describe("nativeWorkspaceDialogService.confirmDelete (FR-068)", () => {
  it("shows the mapped warning text and returns true only for Delete", async () => {
    messageMock.mockResolvedValue(DELETE_BUTTONS.delete);

    await expect(
      nativeWorkspaceDialogService.confirmDelete({
        displayName: "src",
        dirty: false,
        affectedDirtyNames: ["a.ts"],
      }),
    ).resolves.toBe(true);

    expect(messageMock).toHaveBeenCalledTimes(1);
    const [text, options] = messageMock.mock.calls[0] as [
      string,
      { kind?: string; buttons?: Record<string, string> },
    ];
    expect(text).toBe(
      'Move "src" to the Recycle Bin? Unsaved changes in "a.ts" will be lost.',
    );
    expect(options.kind).toBe("warning");
    expect(options.buttons).toEqual({
      ok: DELETE_BUTTONS.delete,
      cancel: DELETE_BUTTONS.cancel,
    });
  });

  it("returns false when the user cancels", async () => {
    messageMock.mockResolvedValue(DELETE_BUTTONS.cancel);

    await expect(
      nativeWorkspaceDialogService.confirmDelete({
        displayName: "a.txt",
        dirty: true,
        affectedDirtyNames: [],
      }),
    ).resolves.toBe(false);
  });

  it("returns false for an unexpected dialog result", async () => {
    messageMock.mockResolvedValue("dismissed");

    await expect(
      nativeWorkspaceDialogService.confirmDelete({
        displayName: "a.txt",
        dirty: false,
        affectedDirtyNames: [],
      }),
    ).resolves.toBe(false);
  });
});

describe("nativeWorkspaceDialogService.showError (US1)", () => {
  it("shows the failure as an error dialog", async () => {
    messageMock.mockResolvedValue("Ok");

    await nativeWorkspaceDialogService.showError("Cannot read directory");

    expect(messageMock).toHaveBeenCalledWith("Cannot read directory", {
      title: "Sorakada",
      kind: "error",
    });
  });
});
