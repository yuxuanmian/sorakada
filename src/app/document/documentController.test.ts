import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";

import type {
  DocumentChangeListener,
  EditorHandle,
} from "../../editor/editorHandle";
import type {
  FileCommandError,
  FileService,
  OpenTextFileResult,
  WriteTextFileRequest,
} from "../../services/fileService";
import type {
  FileDialogService,
  UnsavedChoice,
} from "../../services/fileDialogs";
import { DocumentController } from "./documentController";
import {
  NEW_DOCUMENT_FORMAT,
  UNTITLED_DISPLAY_NAME,
  type ActiveDocumentSession,
  type TextFormat,
} from "./documentSession";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

function toText(value: string): Text {
  return Text.of(value.split("\n"));
}

/**
 * Stands in for the active CodeMirror view.
 *
 * `setDocument` mirrors the real `EditorHandle`: it replaces the document
 * silently. `type` and `applyHistory` mirror what CodeMirror reports through
 * `docChanged`, which is the only signal the controller reacts to.
 */
class FakeEditor implements EditorHandle {
  private doc: Text = Text.empty;
  private listener: DocumentChangeListener | null = null;

  isReady(): boolean {
    return true;
  }

  getDocument(): Text {
    return this.doc;
  }

  focus(): void {}

  undo(): void {}

  redo(): void {}

  setDocumentChangeListener(listener: DocumentChangeListener | null): void {
    this.listener = listener;
  }

  setDocument(text: string): void {
    this.doc = toText(text);
  }

  type(text: string): void {
    this.doc = toText(text);
    this.listener?.();
  }

  applyHistory(text: string): void {
    this.type(text);
  }

  read(): string {
    return this.doc.toString();
  }
}

class FakeFileService implements FileService {
  readonly writes: WriteTextFileRequest[] = [];
  readResult: OpenTextFileResult | null = null;
  readError: FileCommandError | null = null;
  writeError: FileCommandError | null = null;
  holdWrites = false;
  writeCount = 0;

  private pending: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  async readTextFile(path: string): Promise<OpenTextFileResult> {
    if (this.readError) {
      throw this.readError;
    }
    if (!this.readResult) {
      throw {
        code: "io_read",
        message: `No fixture registered for ${path}`,
      } satisfies FileCommandError;
    }
    return this.readResult;
  }

  writeTextFile(request: WriteTextFileRequest): Promise<void> {
    this.writes.push(request);
    this.writeCount += 1;

    if (this.writeError) {
      return Promise.reject(this.writeError);
    }
    if (!this.holdWrites) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  releaseWrites(): void {
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      entry.resolve();
    }
  }

  /** Releases only the oldest in-flight write, to observe serialisation. */
  releaseNextWrite(): void {
    const entry = this.pending.shift();
    if (entry) {
      entry.resolve();
    }
  }

  pendingWriteCount(): number {
    return this.pending.length;
  }

  failPendingWrites(error: unknown): void {
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      entry.reject(error);
    }
  }
}

class FakeDialogs implements FileDialogService {
  openPath: string | null = null;
  savePath: string | null = null;
  unsavedChoice: UnsavedChoice = "cancel";
  readonly errors: string[] = [];
  openPromptCount = 0;
  savePromptCount = 0;
  unsavedPromptCount = 0;

  async pickOpenPath(): Promise<string | null> {
    this.openPromptCount += 1;
    return this.openPath;
  }

  async pickSavePath(): Promise<string | null> {
    this.savePromptCount += 1;
    return this.savePath;
  }

  async showError(text: string): Promise<void> {
    this.errors.push(text);
  }

  async confirmUnsavedChanges(): Promise<UnsavedChoice> {
    this.unsavedPromptCount += 1;
    return this.unsavedChoice;
  }
}

interface Harness {
  editor: FakeEditor;
  files: FakeFileService;
  dialogs: FakeDialogs;
  controller: DocumentController;
  sessions: ActiveDocumentSession[];
  destroyCount(): number;
}

function createHarness(): Harness {
  const editor = new FakeEditor();
  const files = new FakeFileService();
  const dialogs = new FakeDialogs();
  let destroys = 0;

  const controller = new DocumentController({
    editor,
    fileService: files,
    dialogs,
    destroyWindow: async () => {
      destroys += 1;
    },
  });

  // Mirrors the wiring `App` performs: CodeMirror's `docChanged` report is the
  // only thing that makes the controller recompute dirty state.
  editor.setDocumentChangeListener(() => {
    controller.handleDocumentChanged();
  });

  const sessions: ActiveDocumentSession[] = [];
  controller.subscribe((session) => {
    sessions.push({ ...session, format: { ...session.format } });
  });

  return {
    editor,
    files,
    dialogs,
    controller,
    sessions,
    destroyCount: () => destroys,
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CRLF_BOM_FORMAT: TextFormat = {
  encoding: "utf8",
  bom: "utf8",
  detectedLineEnding: "crlf",
  preferredLineEnding: "crlf",
};

const LINUX_PATH = "C:\\work\\notes.txt";

function registerFixture(
  harness: Harness,
  text: string,
  format: TextFormat,
): void {
  harness.files.readResult = { text, format };
  harness.dialogs.openPath = LINUX_PATH;
}

/* -------------------------------------------------------------------------- */
/* User Story 1 — Open, edit and save an existing text file                   */
/* -------------------------------------------------------------------------- */

describe("DocumentController — opening an existing file", () => {
  it("installs the decoded document, its format and a clean baseline", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta", CRLF_BOM_FORMAT);

    const result = await harness.controller.openDocument();

    expect(result).toEqual({ status: "success" });
    expect(harness.editor.read()).toBe("alpha\nbeta");
    expect(harness.controller.getSession()).toEqual({
      path: LINUX_PATH,
      displayName: "notes.txt",
      format: CRLF_BOM_FORMAT,
      dirty: false,
    });
  });

  it("accepts LF-normalized text from the Rust codec without re-normalizing it", async () => {
    const harness = createHarness();
    registerFixture(harness, "one\ntwo\nthree", {
      encoding: "utf8",
      bom: "none",
      detectedLineEnding: "lf",
      preferredLineEnding: "lf",
    });

    await harness.controller.openDocument();

    expect(harness.editor.read()).toBe("one\ntwo\nthree");
    expect(harness.controller.getSession().format.preferredLineEnding).toBe("lf");
  });
});

describe("DocumentController — saving an existing file", () => {
  it("writes an exact snapshot using the retained format and clears dirty", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    harness.editor.type("alpha\nbeta\ngamma");
    expect(harness.controller.getSession().dirty).toBe(true);

    const result = await harness.controller.save();

    expect(result).toEqual({ status: "success" });
    expect(harness.files.writes).toEqual([
      {
        path: LINUX_PATH,
        text: "alpha\nbeta\ngamma",
        bom: "utf8",
        lineEnding: "crlf",
      },
    ]);
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("does not touch the disk when a clean same-path document is saved", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    const result = await harness.controller.save();

    expect(result).toEqual({ status: "success" });
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.dialogs.savePromptCount).toBe(0);
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("leaves an unedited Mixed document untouched on a clean Save", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta\ngamma", {
      encoding: "utf8",
      bom: "none",
      detectedLineEnding: "mixed",
      preferredLineEnding: "crlf",
    });
    await harness.controller.openDocument();

    await harness.controller.save();

    expect(harness.files.writes).toHaveLength(0);
  });
});

describe("DocumentController — Open failures never disturb the current document", () => {
  it("keeps the current document when the open picker is cancelled", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.dialogs.openPath = null;
    const before = harness.controller.getSession();

    const result = await harness.controller.openDocument();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.editor.read()).toBe("edited");
    expect(harness.controller.getSession()).toEqual(before);
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(harness.dialogs.errors).toHaveLength(0);
  });

  it("reports a read/decode failure and preserves path, text, format and dirty state", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");
    const before = harness.controller.getSession();

    harness.dialogs.openPath = "C:\\work\\unsupported.bin";
    harness.files.readError = {
      code: "unsupported_binary",
      message: "The file contains binary data.",
    };

    const result = await harness.controller.openDocument();

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "unsupported_binary",
        message: "The file contains binary data.",
      },
    });
    expect(harness.dialogs.errors).toEqual(["The file contains binary data."]);
    expect(harness.editor.read()).toBe("edited");
    expect(harness.controller.getSession()).toEqual(before);
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
  });

  it("normalizes a non-contract rejection into a readable error", async () => {
    const harness = createHarness();
    harness.dialogs.openPath = LINUX_PATH;
    harness.files.readError = null;
    harness.files.readResult = null;
    const original = harness.files.readTextFile.bind(harness.files);
    harness.files.readTextFile = async () => {
      throw new Error("IPC transport unavailable");
    };

    const result = await harness.controller.openDocument();

    expect(result).toEqual({
      status: "failed",
      error: { code: "io_read", message: "IPC transport unavailable" },
    });
    expect(harness.dialogs.errors).toEqual(["IPC transport unavailable"]);
    void original;
  });
});

describe("DocumentController — Save failures preserve the previous baseline", () => {
  it("keeps the document dirty and the error visible when a save fails", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.files.writeError = {
      code: "io_write",
      message: "Access to the path is denied.",
    };

    const result = await harness.controller.save();

    expect(result).toEqual({
      status: "failed",
      error: { code: "io_write", message: "Access to the path is denied." },
    });
    expect(harness.dialogs.errors).toEqual(["Access to the path is denied."]);
    expect(harness.controller.getSession().dirty).toBe(true);
    expect(harness.controller.getSession().path).toBe(LINUX_PATH);
  });
});

/* -------------------------------------------------------------------------- */
/* User Story 2 — Create a new file or save a copy                            */
/* -------------------------------------------------------------------------- */

describe("DocumentController — New", () => {
  it("creates a clean untitled document with UTF-8/no-BOM/CRLF defaults", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    const result = await harness.controller.newDocument();

    expect(result).toEqual({ status: "success" });
    expect(harness.editor.read()).toBe("");
    expect(harness.controller.getSession()).toEqual({
      path: null,
      displayName: UNTITLED_DISPLAY_NAME,
      format: NEW_DOCUMENT_FORMAT,
      dirty: false,
    });
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
  });
});

describe("DocumentController — Save As", () => {
  it("delegates Save on an untitled document to Save As", async () => {
    const harness = createHarness();
    await harness.controller.newDocument();
    harness.editor.type("first\nsecond");
    harness.dialogs.savePath = "C:\\out\\fresh.txt";

    const result = await harness.controller.save();

    expect(result).toEqual({ status: "success" });
    expect(harness.files.writes).toEqual([
      {
        path: "C:\\out\\fresh.txt",
        text: "first\nsecond",
        bom: "none",
        lineEnding: "crlf",
      },
    ]);
    expect(harness.controller.getSession()).toEqual({
      path: "C:\\out\\fresh.txt",
      displayName: "fresh.txt",
      format: NEW_DOCUMENT_FORMAT,
      dirty: false,
    });
  });

  it("re-associates the path only after a successful write", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("alpha\nbeta\nchanged");
    harness.dialogs.savePath = "D:\\copies\\copy.txt";

    const result = await harness.controller.saveAs();

    expect(result).toEqual({ status: "success" });
    expect(harness.files.writes[0]).toEqual({
      path: "D:\\copies\\copy.txt",
      text: "alpha\nbeta\nchanged",
      // Save As keeps the document's retained format.
      bom: "utf8",
      lineEnding: "crlf",
    });
    expect(harness.controller.getSession().path).toBe("D:\\copies\\copy.txt");
    expect(harness.controller.getSession().displayName).toBe("copy.txt");
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("normalizes edited Mixed content to the dominant style on Save As", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta\ngamma", {
      encoding: "utf8",
      bom: "none",
      detectedLineEnding: "mixed",
      preferredLineEnding: "lf",
    });
    await harness.controller.openDocument();
    harness.editor.type("alpha\nbeta\ngamma\ndelta");
    harness.dialogs.savePath = "C:\\out\\mixed-copy.txt";

    await harness.controller.saveAs();

    expect(harness.files.writes[0].lineEnding).toBe("lf");
  });

  it("prefers CRLF on Save As when a Mixed document's counts tie", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta", {
      encoding: "utf8",
      bom: "none",
      detectedLineEnding: "mixed",
      preferredLineEnding: "crlf",
    });
    await harness.controller.openDocument();
    harness.editor.type("alpha\nbeta\n");
    harness.dialogs.savePath = "C:\\out\\tie.txt";

    await harness.controller.saveAs();

    expect(harness.files.writes[0].lineEnding).toBe("crlf");
  });

  it("leaves the session untouched when Save As is cancelled", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");
    const before = harness.controller.getSession();

    harness.dialogs.savePath = null;
    const result = await harness.controller.saveAs();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.controller.getSession()).toEqual(before);
    expect(harness.controller.getSession().dirty).toBe(true);
  });

  it("leaves the session untouched when the Save As write fails", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");
    const before = harness.controller.getSession();

    harness.dialogs.savePath = "Z:\\missing\\copy.txt";
    harness.files.writeError = {
      code: "io_write",
      message: "The device is not ready.",
    };

    const result = await harness.controller.saveAs();

    expect(result.status).toBe("failed");
    expect(harness.dialogs.errors).toEqual(["The device is not ready."]);
    expect(harness.controller.getSession()).toEqual(before);
    expect(harness.controller.getSession().dirty).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* User Story 3 — Protect unsaved work and track saved state                  */
/* -------------------------------------------------------------------------- */

describe("DocumentController — saved baseline and dirty tracking", () => {
  it("reports dirty after an edit and clean again after Undo returns to the baseline", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha\nbeta", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    harness.editor.applyHistory("alpha\nbeta!");
    expect(harness.controller.getSession().dirty).toBe(true);

    harness.editor.applyHistory("alpha\nbeta");
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("notifies subscribers whenever the derived dirty state changes", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.sessions.length = 0;

    harness.editor.type("alpha!");
    harness.editor.applyHistory("alpha");

    expect(harness.sessions.map((session) => session.dirty)).toEqual([
      true,
      false,
    ]);
  });

  it("keeps newer content dirty when the document is edited while a save is in flight", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("snapshot-A");

    harness.files.holdWrites = true;
    const saving = harness.controller.save();

    harness.editor.type("snapshot-B");
    harness.files.releaseWrites();
    const result = await saving;

    expect(result).toEqual({ status: "success" });
    expect(harness.files.writes[0].text).toBe("snapshot-A");
    expect(harness.controller.getSession().dirty).toBe(true);

    // The saved baseline is the captured snapshot, not the newer content.
    harness.editor.applyHistory("snapshot-A");
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("never advances the baseline when the in-flight save fails", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("snapshot-A");

    harness.files.holdWrites = true;
    const saving = harness.controller.save();
    harness.files.failPendingWrites({
      code: "io_write",
      message: "Disk full.",
    });
    const result = await saving;

    expect(result.status).toBe("failed");
    expect(harness.controller.getSession().dirty).toBe(true);

    harness.editor.applyHistory("alpha");
    expect(harness.controller.getSession().dirty).toBe(false);
    harness.editor.applyHistory("snapshot-A");
    expect(harness.controller.getSession().dirty).toBe(true);
  });
});

describe("DocumentController — unsaved-work guard", () => {
  it("bypasses the prompt entirely for a clean document", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    const result = await harness.controller.newDocument();

    expect(result).toEqual({ status: "success" });
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
  });

  it("New — Cancel keeps the current document exactly as it was", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");
    const before = harness.controller.getSession();

    harness.dialogs.unsavedChoice = "cancel";
    const result = await harness.controller.newDocument();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.editor.read()).toBe("edited");
    expect(harness.controller.getSession()).toEqual(before);
  });

  it("New — Don't Save replaces the document", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.dialogs.unsavedChoice = "dontSave";
    const result = await harness.controller.newDocument();

    expect(result).toEqual({ status: "success" });
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.editor.read()).toBe("");
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("New — Save replaces the document only after the save succeeds", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.dialogs.unsavedChoice = "save";
    const result = await harness.controller.newDocument();

    expect(result).toEqual({ status: "success" });
    expect(harness.files.writes).toEqual([
      { path: LINUX_PATH, text: "edited", bom: "utf8", lineEnding: "crlf" },
    ]);
    expect(harness.controller.getSession().displayName).toBe(
      UNTITLED_DISPLAY_NAME,
    );
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("New — Save aborts the action when the nested Save As is cancelled", async () => {
    const harness = createHarness();
    await harness.controller.newDocument();
    harness.editor.type("unsaved draft");
    const before = harness.controller.getSession();

    harness.dialogs.unsavedChoice = "save";
    harness.dialogs.savePath = null;
    const result = await harness.controller.newDocument();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.editor.read()).toBe("unsaved draft");
    expect(harness.controller.getSession()).toEqual(before);
  });

  it("New — Save aborts the action when the save fails", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.dialogs.unsavedChoice = "save";
    harness.files.writeError = {
      code: "io_write",
      message: "Access to the path is denied.",
    };
    const result = await harness.controller.newDocument();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.editor.read()).toBe("edited");
    expect(harness.controller.getSession().dirty).toBe(true);
  });

  it("Open — prompts only after a successful decode and Cancel keeps the document", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");
    const before = harness.controller.getSession();

    harness.files.readResult = { text: "target", format: CRLF_BOM_FORMAT };
    harness.dialogs.openPath = "C:\\work\\target.txt";
    harness.dialogs.unsavedChoice = "cancel";
    const result = await harness.controller.openDocument();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.dialogs.unsavedPromptCount).toBe(1);
    expect(harness.editor.read()).toBe("edited");
    expect(harness.controller.getSession()).toEqual(before);
  });

  it("Open — Don't Save installs the validated target", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.files.readResult = { text: "target", format: CRLF_BOM_FORMAT };
    harness.dialogs.openPath = "C:\\work\\target.txt";
    harness.dialogs.unsavedChoice = "dontSave";
    const result = await harness.controller.openDocument();

    expect(result).toEqual({ status: "success" });
    expect(harness.editor.read()).toBe("target");
    expect(harness.controller.getSession()).toEqual({
      path: "C:\\work\\target.txt",
      displayName: "target.txt",
      format: CRLF_BOM_FORMAT,
      dirty: false,
    });
  });

  it("Open — Save guards the replacement with a successful save first", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.files.readResult = { text: "target", format: CRLF_BOM_FORMAT };
    harness.dialogs.openPath = "C:\\work\\target.txt";
    harness.dialogs.unsavedChoice = "save";
    const result = await harness.controller.openDocument();

    // The guard saved the *old* document before the target replaced it.
    expect(harness.files.writes).toEqual([
      { path: LINUX_PATH, text: "edited", bom: "utf8", lineEnding: "crlf" },
    ]);
    expect(result).toEqual({ status: "success" });
    expect(harness.editor.read()).toBe("target");
    expect(harness.controller.getSession().path).toBe("C:\\work\\target.txt");
  });

  it("Exit — a clean document closes without prompting or saving", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    const result = await harness.controller.exit();

    expect(result).toEqual({ status: "success" });
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(harness.destroyCount()).toBe(1);
  });

  it("Exit — Cancel keeps the window open", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.dialogs.unsavedChoice = "cancel";
    const result = await harness.controller.exit();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.destroyCount()).toBe(0);
  });

  it("Exit — Don't Save destroys the window", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.dialogs.unsavedChoice = "dontSave";
    const result = await harness.controller.exit();

    expect(result).toEqual({ status: "success" });
    expect(harness.destroyCount()).toBe(1);
  });

  it("Exit — a failed guard save aborts the exit", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited");

    harness.dialogs.unsavedChoice = "save";
    harness.files.writeError = {
      code: "io_write",
      message: "Access to the path is denied.",
    };
    const result = await harness.controller.exit();

    expect(result).toEqual({ status: "cancelled" });
    expect(harness.destroyCount()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Latent saves and overlapping writes                                       */
/* -------------------------------------------------------------------------- */

/** Lets queued microtasks (and the write chain they drive) run to completion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DocumentController — async saves that outlive their document", () => {
  it("ignores a save completion that lands after the document was replaced by Open", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited A");

    harness.files.holdWrites = true;
    const savingA = harness.controller.save();

    // The user opens another document while A's write is still in flight.
    harness.files.readResult = { text: "beta", format: CRLF_BOM_FORMAT };
    harness.dialogs.openPath = "C:\\work\\other.txt";
    harness.dialogs.unsavedChoice = "dontSave";
    const opened = await harness.controller.openDocument();
    expect(opened).toEqual({ status: "success" });
    expect(harness.controller.getSession().path).toBe("C:\\work\\other.txt");
    expect(harness.controller.getSession().dirty).toBe(false);

    // Now the stale write finishes.
    harness.files.releaseWrites();
    await expect(savingA).resolves.toEqual({ status: "success" });

    // B must be untouched: still clean, still B, and still baselined on B.
    expect(harness.controller.getSession()).toEqual({
      path: "C:\\work\\other.txt",
      displayName: "other.txt",
      format: CRLF_BOM_FORMAT,
      dirty: false,
    });
    expect(harness.editor.read()).toBe("beta");

    harness.editor.type("beta!");
    expect(harness.controller.getSession().dirty).toBe(true);
    harness.editor.applyHistory("beta");
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("ignores a save completion that lands after New replaced the document", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited A");

    harness.files.holdWrites = true;
    const savingA = harness.controller.save();

    harness.dialogs.unsavedChoice = "dontSave";
    await harness.controller.newDocument();

    harness.files.releaseWrites();
    await expect(savingA).resolves.toEqual({ status: "success" });

    expect(harness.controller.getSession()).toEqual({
      path: null,
      displayName: "Untitled",
      format: NEW_DOCUMENT_FORMAT,
      dirty: false,
    });
    expect(harness.editor.read()).toBe("");
  });

  it("does not let a superseded Save As adopt its path onto the new document", async () => {
    const harness = createHarness();
    await harness.controller.newDocument();
    harness.editor.type("draft");

    harness.dialogs.savePath = "C:\\out\\draft.txt";
    harness.files.holdWrites = true;
    const savingAs = harness.controller.saveAs();

    harness.dialogs.unsavedChoice = "dontSave";
    await harness.controller.newDocument();
    expect(harness.controller.getSession().path).toBeNull();

    harness.files.releaseWrites();
    await expect(savingAs).resolves.toEqual({ status: "success" });

    expect(harness.controller.getSession()).toMatchObject({
      path: null,
      displayName: "Untitled",
      dirty: false,
    });
  });

  it("still reports a superseded write's failure without disturbing the new document", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();
    harness.editor.type("edited A");

    harness.files.holdWrites = true;
    const savingA = harness.controller.save();

    harness.files.readResult = { text: "beta", format: CRLF_BOM_FORMAT };
    harness.dialogs.openPath = "C:\\work\\other.txt";
    harness.dialogs.unsavedChoice = "dontSave";
    await harness.controller.openDocument();

    harness.files.failPendingWrites({
      code: "io_write",
      message: "Disk full.",
    });
    await expect(savingA).resolves.toMatchObject({ status: "failed" });
    expect(harness.dialogs.errors).toEqual(["Disk full."]);
    expect(harness.controller.getSession().path).toBe("C:\\work\\other.txt");
    expect(harness.controller.getSession().dirty).toBe(false);
  });
});

describe("DocumentController — overlapping writes to the same path", () => {
  it("issues a second save only after the first one has completed", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    harness.files.holdWrites = true;

    harness.editor.type("first");
    const first = harness.controller.save();
    await flush();
    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0]?.text).toBe("first");

    harness.editor.type("second");
    const second = harness.controller.save();
    await flush();
    // Still one write: the second is queued behind the first.
    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.pendingWriteCount()).toBe(1);

    harness.files.releaseNextWrite();
    await flush();
    // Only now is the second write issued, carrying the newer snapshot.
    expect(harness.files.writes).toHaveLength(2);
    expect(harness.files.writes[1]?.text).toBe("second");

    harness.files.releaseNextWrite();
    await expect(first).resolves.toEqual({ status: "success" });
    await expect(second).resolves.toEqual({ status: "success" });
    expect(harness.controller.getSession().dirty).toBe(false);
  });

  it("does not let a failed write block the next save to the same path", async () => {
    const harness = createHarness();
    registerFixture(harness, "alpha", CRLF_BOM_FORMAT);
    await harness.controller.openDocument();

    harness.files.writeError = {
      code: "io_write",
      message: "Access to the path is denied.",
    };
    harness.editor.type("attempt one");
    const failed = await harness.controller.save();
    expect(failed).toMatchObject({ status: "failed" });
    expect(harness.controller.getSession().dirty).toBe(true);

    harness.files.writeError = null;
    harness.editor.type("attempt two");
    const retried = await harness.controller.save();

    expect(retried).toEqual({ status: "success" });
    expect(harness.files.writes).toHaveLength(2);
    expect(harness.controller.getSession().dirty).toBe(false);
  });
});
