import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@tauri-apps/plugin-dialog` is mocked so the adapter can be pinned against
 * the values the native plugin actually resolves with.
 *
 * The important case is the unsaved-work prompt: `tauri-plugin-dialog` runs
 * `YesNoCancelCustom` buttons through `rfd` and rewrites Yes/No/Cancel into
 * `MessageDialogResult::Custom(<label>)`, which is `#[serde(untagged)]`. The
 * value that reaches this adapter is therefore the *label*
 * (`"Save"` / `"Don't Save"` / `"Cancel"`), never the role name.
 */
const { openMock, saveMock, messageMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  saveMock: vi.fn(),
  messageMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
  save: saveMock,
  message: messageMock,
}));

import {
  UNSAVED_WORK_BUTTONS,
  nativeFileDialogService,
  toUnsavedChoice,
} from "./fileDialogs";
import type { UnsavedChoice } from "./fileDialogs";

beforeEach(() => {
  openMock.mockReset();
  saveMock.mockReset();
  messageMock.mockReset();
});

describe("confirmUnsavedChanges", () => {
  it("asks with the three custom button labels", async () => {
    messageMock.mockResolvedValue(UNSAVED_WORK_BUTTONS.save);

    await nativeFileDialogService.confirmUnsavedChanges("notes.txt");

    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(messageMock).toHaveBeenCalledWith("Save changes to notes.txt?", {
      title: "Sorakada",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
  });

  // Regression: the plugin resolves with the custom *labels*, so comparing
  // against the "Yes"/"No" role names made the guard always answer "cancel",
  // which silently blocked every Tab close and window exit for a dirty
  // document. New and Open never run this guard in 002.
  const labelCases: Array<[string, UnsavedChoice]> = [
    [UNSAVED_WORK_BUTTONS.save, "save"],
    [UNSAVED_WORK_BUTTONS.dontSave, "dontSave"],
    [UNSAVED_WORK_BUTTONS.cancel, "cancel"],
  ];

  for (const [label, expected] of labelCases) {
    it(`maps the native label ${JSON.stringify(label)} to ${expected}`, async () => {
      messageMock.mockResolvedValue(label);

      await expect(
        nativeFileDialogService.confirmUnsavedChanges("Untitled"),
      ).resolves.toBe(expected);
    });
  }

  it("still understands the OS default button roles", async () => {
    messageMock.mockResolvedValue("Yes");
    await expect(
      nativeFileDialogService.confirmUnsavedChanges("Untitled"),
    ).resolves.toBe("save");

    messageMock.mockResolvedValue("No");
    await expect(
      nativeFileDialogService.confirmUnsavedChanges("Untitled"),
    ).resolves.toBe("dontSave");
  });

  it("treats a dismissed or unexpected result as cancel", async () => {
    for (const result of ["Ok", "", "something-else"]) {
      messageMock.mockResolvedValue(result);
      await expect(
        nativeFileDialogService.confirmUnsavedChanges("Untitled"),
      ).resolves.toBe("cancel");
    }
  });
});

describe("toUnsavedChoice", () => {
  it("never maps a non-Save answer onto save", () => {
    expect(toUnsavedChoice("Don't Save")).toBe("dontSave");
    expect(toUnsavedChoice("Cancel")).toBe("cancel");
    expect(toUnsavedChoice("Ok")).toBe("cancel");
  });

  it("distinguishes each of the three buttons", () => {
    expect(toUnsavedChoice("Save")).toBe("save");
    expect(toUnsavedChoice("Don't Save")).toBe("dontSave");
    expect(toUnsavedChoice("Cancel")).toBe("cancel");
  });
});

describe("pickOpenPath", () => {
  it("returns the selected path and disallows multi-selection", async () => {
    openMock.mockResolvedValue("C:\\work\\notes.txt");

    await expect(nativeFileDialogService.pickOpenPath()).resolves.toBe(
      "C:\\work\\notes.txt",
    );
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Open File",
        multiple: false,
        directory: false,
      }),
    );
  });

  it("resolves null when the picker is cancelled", async () => {
    openMock.mockResolvedValue(null);
    await expect(nativeFileDialogService.pickOpenPath()).resolves.toBeNull();
  });

  it("resolves null for a non-string selection", async () => {
    openMock.mockResolvedValue(["a.txt", "b.txt"]);
    await expect(nativeFileDialogService.pickOpenPath()).resolves.toBeNull();
  });
});

describe("pickSavePath", () => {
  it("prefills the current path when the document already has one", async () => {
    saveMock.mockResolvedValue("C:\\work\\copy.txt");

    await expect(
      nativeFileDialogService.pickSavePath("C:\\work\\notes.txt"),
    ).resolves.toBe("C:\\work\\copy.txt");

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Save As",
        defaultPath: "C:\\work\\notes.txt",
      }),
    );
  });

  it("omits defaultPath for an untitled document", async () => {
    saveMock.mockResolvedValue("C:\\work\\fresh.txt");

    await nativeFileDialogService.pickSavePath(null);

    const options = saveMock.mock.calls[0][0] as Record<string, unknown>;
    expect("defaultPath" in options).toBe(false);
    expect(options.title).toBe("Save As");
  });

  it("resolves null when the picker is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    await expect(nativeFileDialogService.pickSavePath(null)).resolves.toBeNull();
  });
});

describe("showError", () => {
  it("shows an error-kind message dialog", async () => {
    messageMock.mockResolvedValue("Ok");

    await nativeFileDialogService.showError("The file contains binary data.");

    expect(messageMock).toHaveBeenCalledWith("The file contains binary data.", {
      title: "Sorakada",
      kind: "error",
    });
  });
});
