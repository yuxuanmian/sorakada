import { describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";

import { DocumentManager } from "../document/documentManager";
import type {
  OpenPathOptions,
  OpenPathResult,
} from "../document/documentManager";
import {
  NEW_DOCUMENT_FORMAT,
  type DocumentId,
  type DocumentViewState,
} from "../document/documentSession";
import type { EditorHandle, StateUpdateListener } from "../../editor/editorHandle";
import type {
  FileService,
  OpenTextFileResult,
  ResolvedPathIdentity,
  WriteTextFileRequest,
} from "../../services/fileService";
import type {
  FileDialogService,
  UnsavedChoice,
} from "../../services/fileDialogs";
import { processDroppedPaths, type FileDropManager } from "./fileDropController";

/* -------------------------------------------------------------------------- */
/* Test double                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Stands in for `DocumentManager`.
 *
 * It records the exact order open requests arrive in and can hold a request
 * open, which is how the sequential-processing rule is observable without a
 * desktop session.
 */
class FakeDropManager implements FileDropManager {
  readonly requests: Array<{ path: string; options: OpenPathOptions | undefined }> =
    [];
  readonly activated: DocumentId[] = [];

  /** When set, `openPath` stays pending until `release` is called. */
  hold = false;

  private readonly results = new Map<string, OpenPathResult>();
  private held: Array<{ path: string; resolve: () => void }> = [];

  script(path: string, result: OpenPathResult): void {
    this.results.set(path, result);
  }

  scriptFailed(path: string): void {
    this.script(path, {
      status: "failed",
      error: { code: "unsupported_binary", message: `${path} is binary.` },
    });
  }

  openPath(path: string, options?: OpenPathOptions): Promise<OpenPathResult> {
    this.requests.push({ path, options });

    const result = this.results.get(path) ?? {
      status: "failed" as const,
      error: { code: "io_read" as const, message: `No fixture for ${path}` },
    };

    if (!this.hold) {
      return Promise.resolve(result);
    }

    return new Promise<OpenPathResult>((resolve) => {
      this.held.push({ path, resolve: () => resolve(result) });
    });
  }

  activateDocument(id: DocumentId): void {
    this.activated.push(id);
  }

  /** Completes the oldest held request. */
  release(): void {
    this.held.shift()?.resolve();
  }

  requestedPaths(): string[] {
    return this.requests.map((request) => request.path);
  }
}

/** Lets every already-queued microtask chain run up to its next real await. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const VALID_A = "C:\\work\\a.txt";
const VALID_B = "C:\\work\\b.txt";
const BINARY = "C:\\work\\broken.bin";
const DIRECTORY = "C:\\work\\folder";
const DUPLICATE_A = "C:\\work\\.\\a.txt";

/* -------------------------------------------------------------------------- */
/* Batch orchestration                                                        */
/* -------------------------------------------------------------------------- */

describe("processDroppedPaths", () => {
  it("opens a dropped batch in the order it was dropped", async () => {
    const manager = new FakeDropManager();
    manager.script(VALID_A, { status: "opened", documentId: "doc-a" });
    manager.script(VALID_B, { status: "opened", documentId: "doc-b" });

    const lastId = await processDroppedPaths([VALID_A, VALID_B], manager);

    expect(manager.requestedPaths()).toEqual([VALID_A, VALID_B]);
    expect(lastId).toBe("doc-b");
  });

  it("awaits one path before starting the next", async () => {
    const manager = new FakeDropManager();
    manager.script(VALID_A, { status: "opened", documentId: "doc-a" });
    manager.script(VALID_B, { status: "opened", documentId: "doc-b" });
    manager.hold = true;

    const batch = processDroppedPaths([VALID_A, VALID_B], manager);
    await flush();

    expect(manager.requestedPaths()).toEqual([VALID_A]);

    manager.release();
    await flush();

    expect(manager.requestedPaths()).toEqual([VALID_A, VALID_B]);

    manager.release();
    await batch;
  });

  it("continues the batch after a failed path", async () => {
    const manager = new FakeDropManager();
    manager.script(VALID_A, { status: "opened", documentId: "doc-a" });
    manager.scriptFailed(BINARY);
    manager.script(VALID_B, { status: "opened", documentId: "doc-b" });

    const lastId = await processDroppedPaths(
      [VALID_A, BINARY, VALID_B],
      manager,
    );

    expect(manager.requestedPaths()).toEqual([VALID_A, BINARY, VALID_B]);
    expect(lastId).toBe("doc-b");
  });

  it("keeps going when every dropped path fails", async () => {
    const manager = new FakeDropManager();
    manager.scriptFailed(BINARY);

    const lastId = await processDroppedPaths([BINARY, BINARY], manager);

    expect(manager.requestedPaths()).toEqual([BINARY, BINARY]);
    expect(lastId).toBeNull();
    expect(manager.activated).toEqual([]);
  });

  it("asks the manager to ignore directories and treats the skip as handled", async () => {
    const manager = new FakeDropManager();
    manager.script(DIRECTORY, { status: "ignored-directory" });
    manager.script(VALID_B, { status: "opened", documentId: "doc-b" });

    const lastId = await processDroppedPaths([DIRECTORY, VALID_B], manager);

    expect(
      manager.requests.map((request) => request.options),
    ).toEqual([{ ignoreDirectories: true }, { ignoreDirectories: true }]);
    // A skipped directory is not a "handled document".
    expect(lastId).toBe("doc-b");
  });

  it("does not leave a directory as the active document", async () => {
    const manager = new FakeDropManager();
    manager.script(VALID_A, { status: "opened", documentId: "doc-a" });
    manager.script(DIRECTORY, { status: "ignored-directory" });

    const lastId = await processDroppedPaths([VALID_A, DIRECTORY], manager);

    expect(lastId).toBe("doc-a");
    expect(manager.activated).toEqual(["doc-a"]);
  });

  it("counts an already-open duplicate as a successful handle", async () => {
    const manager = new FakeDropManager();
    manager.script(VALID_A, { status: "opened", documentId: "doc-a" });
    manager.script(DUPLICATE_A, {
      status: "activated-existing",
      documentId: "doc-a",
    });
    manager.script(VALID_B, { status: "opened", documentId: "doc-b" });

    const lastId = await processDroppedPaths(
      [VALID_A, DUPLICATE_A, VALID_B],
      manager,
    );

    expect(lastId).toBe("doc-b");
  });

  it("activates the last successfully handled document once", async () => {
    const manager = new FakeDropManager();
    manager.script(VALID_A, { status: "opened", documentId: "doc-a" });
    manager.scriptFailed(BINARY);
    manager.script(VALID_B, { status: "activated-existing", documentId: "doc-b" });

    await processDroppedPaths([VALID_A, BINARY, VALID_B], manager);

    // One activation at the end, for the last successful entry only.
    expect(manager.activated).toEqual(["doc-b"]);
  });

  it("activates nothing when no dropped path was handled", async () => {
    const manager = new FakeDropManager();
    manager.script(DIRECTORY, { status: "ignored-directory" });
    manager.scriptFailed(BINARY);

    const lastId = await processDroppedPaths([DIRECTORY, BINARY], manager);

    expect(lastId).toBeNull();
    expect(manager.activated).toEqual([]);
  });

  it("does nothing for an empty dropped batch", async () => {
    const manager = new FakeDropManager();

    await expect(processDroppedPaths([], manager)).resolves.toBeNull();

    expect(manager.requests).toEqual([]);
    expect(manager.activated).toEqual([]);
  });

  it("handles the full mixed batch from the quickstart scenario", async () => {
    const manager = new FakeDropManager();
    manager.script(VALID_A, { status: "opened", documentId: "doc-a" });
    manager.scriptFailed(BINARY);
    manager.script(DIRECTORY, { status: "ignored-directory" });
    manager.script(VALID_B, { status: "opened", documentId: "doc-b" });

    const lastId = await processDroppedPaths(
      [VALID_A, BINARY, DIRECTORY, VALID_B],
      manager,
    );

    expect(manager.requestedPaths()).toEqual([
      VALID_A,
      BINARY,
      DIRECTORY,
      VALID_B,
    ]);
    expect(lastId).toBe("doc-b");
    expect(manager.activated).toEqual(["doc-b"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Duplicate reuse through a real manager (SC-002)                            */
/* -------------------------------------------------------------------------- */

/** The smallest editor that can stand in for the shared CodeMirror view. */
class MinimalEditor implements EditorHandle {
  readonly extensions: Extension = [];

  private state: EditorState = EditorState.create({ doc: "" });
  private listener: StateUpdateListener | null = null;

  isReady(): boolean {
    return true;
  }

  attach(): void {}

  detach(): void {}

  getState(): EditorState {
    return this.state;
  }

  setState(_documentId: DocumentId, state: EditorState): void {
    this.state = state;
  }

  captureViewState(): DocumentViewState {
    return { scrollTop: 0, scrollLeft: 0 };
  }

  restoreViewState(): void {}

  focus(): void {}

  undo(): void {}

  redo(): void {}

  setStateUpdateListener(listener: StateUpdateListener | null): void {
    this.listener = listener;
  }

  currentListener(): StateUpdateListener | null {
    return this.listener;
  }
}

/** A filesystem where every registered path resolves to one comparison key. */
class InMemoryFileService implements FileService {
  readonly reads: string[] = [];
  readonly writes: WriteTextFileRequest[] = [];

  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();
  private readonly aliases = new Map<string, string>();

  add(path: string, text = "content"): void {
    this.files.set(this.keyFor(path), text);
  }

  addDirectory(path: string): void {
    this.directories.add(this.keyFor(path));
  }

  /** Registers an equivalent spelling that resolves to `canonical`. */
  addAlias(alias: string, canonical: string): void {
    this.aliases.set(alias, canonical);
  }

  keyFor(path: string): string {
    const source = this.aliases.get(path) ?? path;
    return source.replace(/\\/g, "/").toLowerCase();
  }

  inspectFilePath(
    path: string,
    allowMissing: boolean,
  ): Promise<ResolvedPathIdentity> {
    const comparisonKey = this.keyFor(path);

    if (this.directories.has(comparisonKey)) {
      return Promise.resolve({
        requestedPath: path,
        canonicalPath: path,
        comparisonKey,
        kind: "directory",
        diskRevision: { size: 0, modifiedTimeMillis: 0 },
      });
    }

    const text = this.files.get(comparisonKey);

    if (text === undefined) {
      if (!allowMissing) {
        return Promise.reject({
          code: "path_resolution",
          message: `Path does not exist: ${path}`,
        });
      }
      return Promise.resolve({
        requestedPath: path,
        canonicalPath: path,
        comparisonKey,
        kind: "missing",
        diskRevision: null,
      });
    }

    return Promise.resolve({
      requestedPath: path,
      canonicalPath: path,
      comparisonKey,
      kind: "file",
      diskRevision: { size: text.length, modifiedTimeMillis: 0 },
    });
  }

  readTextFile(path: string): Promise<OpenTextFileResult> {
    this.reads.push(path);
    const text = this.files.get(this.keyFor(path));

    if (text === undefined) {
      return Promise.reject({
        code: "io_read",
        message: `No file for ${path}`,
      });
    }

    return Promise.resolve({ text, format: { ...NEW_DOCUMENT_FORMAT } });
  }

  writeTextFile(request: WriteTextFileRequest): Promise<void> {
    this.writes.push(request);
    return Promise.resolve();
  }
}

class RecordingDialogs implements FileDialogService {
  openPath: string | null = null;
  readonly errors: string[] = [];

  pickOpenPath(): Promise<string | null> {
    return Promise.resolve(this.openPath);
  }

  pickSavePath(): Promise<string | null> {
    return Promise.resolve(null);
  }

  showError(text: string): Promise<void> {
    this.errors.push(text);
    return Promise.resolve();
  }

  confirmUnsavedChanges(): Promise<UnsavedChoice> {
    return Promise.resolve("cancel");
  }
}

describe("duplicate reuse across opening surfaces (SC-002)", () => {
  it("keeps exactly one session for a comparison key across 20 alternating requests", async () => {
    const files = new InMemoryFileService();
    files.add(VALID_A, "alpha");
    files.addAlias(DUPLICATE_A, VALID_A);

    const dialogs = new RecordingDialogs();
    const manager = new DocumentManager({
      editor: new MinimalEditor(),
      fileService: files,
      dialogs,
    });
    const key = files.keyFor(VALID_A);

    for (let request = 0; request < 20; request += 1) {
      const viaDialog = request % 2 === 0;
      const path = viaDialog ? VALID_A : DUPLICATE_A;

      if (viaDialog) {
        dialogs.openPath = path;
        await manager.openFromDialog();
      } else {
        await processDroppedPaths([path], manager);
      }

      const owners = manager
        .listSessions()
        .filter((session) => session.pathIdentity?.comparisonKey === key);

      expect(owners).toHaveLength(1);
      expect(manager.getSnapshot().activeDocumentId).toBe(owners[0].id);
      // A duplicate request activates the existing session and never rewrites
      // the path that session was opened with.
      expect(owners[0].path).toBe(VALID_A);
    }

    // Exactly one document was created, and the file was read only once.
    // 003 starts from zero documents, so the drop batch produced the only Tab.
    expect(manager.listSessions()).toHaveLength(1);
    expect(files.reads).toHaveLength(1);
    expect(tabNames(manager)).toEqual(["a.txt"]);
  });
});

/* -------------------------------------------------------------------------- */
/* US3 — mixed batches and Workspace independence (FR-044..FR-048)             */
/* -------------------------------------------------------------------------- */

describe("dropped batches and the Workspace (US3)", () => {
  it("ignores directories while continuing to open the files around them", async () => {
    const files = new InMemoryFileService();
    files.add(VALID_A, "alpha");
    files.add(VALID_B, "bravo");
    files.addDirectory(DIRECTORY);

    const dialogs = new RecordingDialogs();
    const manager = new DocumentManager({
      editor: new MinimalEditor(),
      fileService: files,
      dialogs,
    });

    // A mixed batch: the directory is skipped without a prompt, and the files
    // on either side still open in drop order.
    const lastHandled = await processDroppedPaths(
      [VALID_A, DIRECTORY, VALID_B],
      manager,
    );

    expect(files.reads).toEqual([VALID_A, VALID_B]);
    expect(tabNames(manager)).toEqual(["a.txt", "b.txt"]);
    expect(dialogs.errors).toHaveLength(0);
    expect(lastHandled).toBe(manager.getSnapshot().activeDocumentId);
  });

  it("opens an inside- and an outside-Workspace file the same way", async () => {
    const files = new InMemoryFileService();
    const INSIDE = "C:\\work\\src\\a.ts";
    const OUTSIDE = "D:\\elsewhere\\b.ts";
    files.add(INSIDE, "inside");
    files.add(OUTSIDE, "outside");

    const manager = new DocumentManager({
      editor: new MinimalEditor(),
      fileService: files,
      dialogs: new RecordingDialogs(),
    });

    // Drop order decides Tab order; both are ordinary documents because the
    // Workspace is a navigation context, not a document owner (FR-045, FR-047).
    await processDroppedPaths([INSIDE, OUTSIDE], manager);

    expect(tabNames(manager)).toEqual(["a.ts", "b.ts"]);
    expect(manager.listSessions()).toHaveLength(2);
  });

  it("activates the existing session when a dropped file is already open", async () => {
    const files = new InMemoryFileService();
    files.add(VALID_A, "alpha");
    files.addAlias(DUPLICATE_A, VALID_A);

    const dialogs = new RecordingDialogs();
    const manager = new DocumentManager({
      editor: new MinimalEditor(),
      fileService: files,
      dialogs,
    });

    const first = await processDroppedPaths([VALID_A], manager);
    const second = await processDroppedPaths([DUPLICATE_A], manager);

    // One canonical destination, one session, whichever spelling was dropped.
    expect(second).toBe(first);
    expect(manager.listSessions()).toHaveLength(1);
    expect(files.reads).toHaveLength(1);
  });
});

function tabNames(manager: DocumentManager): string[] {
  return manager.getSnapshot().tabs.map((tab) => tab.displayName);
}
