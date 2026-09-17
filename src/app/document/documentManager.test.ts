import { describe, expect, it } from "vitest";
import { EditorState, Text, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { EditorHandle, StateUpdateListener } from "../../editor/editorHandle";
import type {
  FileCommandError,
  FileService,
  OpenTextFileResult,
  ResolvedPathIdentity,
  WriteTextFileRequest,
} from "../../services/fileService";
import type {
  FileDialogService,
  UnsavedChoice,
} from "../../services/fileDialogs";
import { DocumentManager } from "./documentManager";
import {
  NEW_DOCUMENT_FORMAT,
  type DocumentId,
  type DocumentManagerSnapshot,
  type DocumentViewState,
  type TextFormat,
} from "./documentSession";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_FORMAT: TextFormat = { ...NEW_DOCUMENT_FORMAT };

/**
 * Stands in for the shared CodeMirror view.
 *
 * It models exactly the guarantees the editor bridge contract makes: the bound
 * document id is set *before* a new state is installed, every state update is
 * reported with that id, and view state is captured/restored outside
 * `EditorState`. No DOM is involved.
 */
class FakeEditor implements EditorHandle {
  readonly extensions: Extension = [];

  ready = true;
  boundDocumentId: DocumentId | null = null;
  state: EditorState | null = null;
  scroll = { scrollTop: 0, scrollLeft: 0 };

  readonly setStateCalls: Array<{ documentId: DocumentId; state: EditorState }> = [];
  readonly restoredViewStates: DocumentViewState[] = [];
  focusCount = 0;
  undoCount = 0;
  redoCount = 0;

  private listener: StateUpdateListener | null = null;

  isReady(): boolean {
    return this.ready;
  }

  attach(_view: EditorView, documentId: DocumentId): void {
    this.boundDocumentId = documentId;
  }

  detach(): void {
    this.boundDocumentId = null;
  }

  getState(): EditorState {
    if (this.state === null) {
      throw new Error("No state is bound to the fake editor.");
    }
    return this.state;
  }

  setState(documentId: DocumentId, state: EditorState): void {
    // MUST happen before the state is installed: an update produced by the swap
    // belongs to the target document, never to the previous one.
    this.boundDocumentId = documentId;
    this.state = state;
    this.setStateCalls.push({ documentId, state });
    this.listener?.(documentId, state, false);
  }

  captureViewState(): DocumentViewState {
    return { ...this.scroll };
  }

  restoreViewState(viewState: DocumentViewState): void {
    this.scroll = {
      scrollTop: viewState.scrollTop,
      scrollLeft: viewState.scrollLeft,
    };
    this.restoredViewStates.push(viewState);
  }

  focus(): void {
    this.focusCount += 1;
  }

  undo(): void {
    this.undoCount += 1;
  }

  redo(): void {
    this.redoCount += 1;
  }

  setStateUpdateListener(listener: StateUpdateListener | null): void {
    this.listener = listener;
  }

  /** Models a user edit in the bound document, which CodeMirror reports as `docChanged`. */
  type(text: string): void {
    this.deliver(EditorState.create({ doc: toText(text) }), true);
  }

  /** Models Undo/Redo, which also change the document. */
  applyHistory(text: string): void {
    this.type(text);
  }

  /**
   * Models cursor/selection movement: a brand new state whose document is
   * unchanged, reported with `docChanged === false`.
   */
  moveCursor(): void {
    const current = this.requireBoundState();
    this.deliver(EditorState.create({ doc: current.doc }), false);
  }

  read(): string {
    return this.requireBoundState().doc.toString();
  }

  private deliver(state: EditorState, docChanged: boolean): void {
    const boundDocumentId = this.boundDocumentId;
    if (boundDocumentId === null) {
      throw new Error("No document is bound to the fake editor.");
    }
    this.state = state;
    this.listener?.(boundDocumentId, state, docChanged);
  }

  private requireBoundState(): EditorState {
    if (this.state === null) {
      throw new Error("No state is bound to the fake editor.");
    }
    return this.state;
  }
}

function toText(value: string): Text {
  return Text.of(value.split("\n"));
}

/**
 * Stands in for the Rust-backed file service.
 *
 * Paths are keyed by a normalized comparison key so a test can make two
 * spellings resolve to the same identity, and reads/writes can be held open to
 * model in-flight asynchronous work.
 */
class FakeFileService implements FileService {
  readonly reads: string[] = [];
  readonly writes: WriteTextFileRequest[] = [];
  readonly inspections: Array<{ path: string; allowMissing: boolean }> = [];

  /** Registered existing files and directories, keyed by comparison key. */
  private readonly files = new Map<string, OpenTextFileResult | FileCommandError>();
  private readonly directories = new Set<string>();
  /** Alternative spellings that must resolve to another path's identity. */
  private readonly aliases = new Map<string, string>();

  /** 1-based write indices that must fail, to place a save failure precisely. */
  readonly failWriteIndexes = new Set<number>();
  writeCallCount = 0;

  readError: FileCommandError | null = null;
  inspectError: FileCommandError | null = null;
  writeError: FileCommandError | null = null;
  holdWrites = false;
  /** Holds every read open, so overlapping open requests can be observed. */
  holdReads = false;

  private pending: Array<{
    request: WriteTextFileRequest;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  private pendingReads: Array<{ resolve: () => void }> = [];

  /* -------- fixtures -------- */

  addFile(path: string, text = "", format: TextFormat = DEFAULT_FORMAT): void {
    this.files.set(this.keyFor(path), {
      text,
      format: { ...format },
    });
  }

  addUnreadableFile(path: string, error: FileCommandError): void {
    this.files.set(this.keyFor(path), error);
  }

  addDirectory(path: string): void {
    this.directories.add(this.keyFor(path));
  }

  /** Makes `alias` resolve to `canonical`'s identity, as a link or `..` would. */
  alias(alias: string, canonical: string): void {
    this.aliases.set(alias, canonical);
  }

  /* -------- FileService -------- */

  inspectFilePath(
    path: string,
    allowMissing: boolean,
  ): Promise<ResolvedPathIdentity> {
    this.inspections.push({ path, allowMissing });

    if (this.inspectError) {
      return Promise.reject(this.inspectError);
    }

    const key = this.keyFor(path);

    if (this.directories.has(key)) {
      return Promise.resolve(this.identityFor(path, key, "directory"));
    }

    const entry = this.files.get(key);
    if (entry !== undefined) {
      return Promise.resolve(this.identityFor(path, key, "file"));
    }

    if (!allowMissing) {
      return Promise.reject({
        code: "path_resolution",
        message: `Path does not exist: ${path}`,
      } satisfies FileCommandError);
    }

    return Promise.resolve(this.identityFor(path, key, "missing"));
  }

  readTextFile(path: string): Promise<OpenTextFileResult> {
    this.reads.push(path);

    if (this.readError) {
      return Promise.reject(this.readError);
    }

    const entry = this.files.get(this.keyFor(path));
    if (entry === undefined) {
      return Promise.reject({
        code: "io_read",
        message: `No fixture registered for ${path}`,
      } satisfies FileCommandError);
    }
    if ("code" in entry) {
      return Promise.reject(entry);
    }

    const result: OpenTextFileResult = {
      text: entry.text,
      format: { ...entry.format },
    };

    if (!this.holdReads) {
      return Promise.resolve(result);
    }

    return new Promise<OpenTextFileResult>((resolve) => {
      this.pendingReads.push({ resolve: () => resolve(result) });
    });
  }

  writeTextFile(request: WriteTextFileRequest): Promise<void> {
    this.writes.push(request);
    this.writeCallCount += 1;

    if (this.failWriteIndexes.has(this.writeCallCount)) {
      return Promise.reject(
        this.writeError ?? {
          code: "io_write",
          message: `Write ${this.writeCallCount} failed.`,
        },
      );
    }
    if (this.writeError) {
      return Promise.reject(this.writeError);
    }
    if (!this.holdWrites) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
    });
  }

  /* -------- test control -------- */

  releaseWrites(): void {
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      entry.resolve();
    }
  }

  /** Releases only the oldest in-flight write, to observe issue ordering. */
  releaseNextWrite(): void {
    this.pending.shift()?.resolve();
  }

  /** Releases only the newest in-flight write, to model out-of-order completion. */
  releaseLastWrite(): void {
    this.pending.pop()?.resolve();
  }

  /** Completes every held read. */
  releaseReads(): void {
    const pendingReads = this.pendingReads;
    this.pendingReads = [];
    for (const entry of pendingReads) {
      entry.resolve();
    }
  }

  pendingReadCount(): number {
    return this.pendingReads.length;
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

  comparisonKeyFor(path: string): string {
    return this.keyFor(path);
  }

  private keyFor(path: string): string {
    const source = this.aliases.get(path) ?? path;
    return source
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/\.\//g, "/")
      .toLowerCase();
  }

  private identityFor(
    path: string,
    comparisonKey: string,
    kind: ResolvedPathIdentity["kind"],
  ): ResolvedPathIdentity {
    return {
      requestedPath: path,
      canonicalPath: path,
      comparisonKey,
      kind,
      diskRevision: kind === "missing" ? null : { size: 0, modifiedTimeMillis: 0 },
    };
  }
}

class FakeDialogs implements FileDialogService {
  openPath: string | null = null;
  savePath: string | null = null;
  unsavedChoice: UnsavedChoice = "cancel";

  /** Per-prompt answers consumed in order; once empty `unsavedChoice` applies. */
  choices: UnsavedChoice[] = [];
  /** Per-request Save As targets consumed in order; once empty `savePath` applies. */
  savePaths: string[] = [];

  readonly errors: string[] = [];
  unsavedPromptCount = 0;
  readonly unsavedPrompts: string[] = [];

  pickOpenPath(): Promise<string | null> {
    return Promise.resolve(this.openPath);
  }

  pickSavePath(): Promise<string | null> {
    return Promise.resolve(
      this.savePaths.length > 0 ? this.savePaths.shift()! : this.savePath,
    );
  }

  showError(text: string): Promise<void> {
    this.errors.push(text);
    return Promise.resolve();
  }

  confirmUnsavedChanges(displayName: string): Promise<UnsavedChoice> {
    this.unsavedPromptCount += 1;
    this.unsavedPrompts.push(displayName);
    return Promise.resolve(
      this.choices.length > 0 ? this.choices.shift()! : this.unsavedChoice,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  manager: DocumentManager;
  editor: FakeEditor;
  files: FakeFileService;
  dialogs: FakeDialogs;
  snapshots: DocumentManagerSnapshot[];
  emissions(): number;
}

function createHarness(): Harness {
  const editor = new FakeEditor();
  const files = new FakeFileService();
  const dialogs = new FakeDialogs();
  const manager = new DocumentManager({
    editor,
    fileService: files,
    dialogs,
  });

  const snapshots: DocumentManagerSnapshot[] = [];
  manager.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });

  // Mirrors the application wiring: the `Editor` component mounts the initial
  // document into the shared view, then the bridge reports every state update
  // with the document id currently bound.
  const initial = manager.getActiveSession();
  editor.setState(initial.id, initial.editorState);
  editor.setStateUpdateListener((documentId, state, docChanged) => {
    manager.handleEditorStateUpdate(documentId, state, docChanged);
  });

  return {
    manager,
    editor,
    files,
    dialogs,
    snapshots,
    emissions: () => snapshots.length,
  };
}

function tabNames(snapshot: DocumentManagerSnapshot): string[] {
  return snapshot.tabs.map((tab) => tab.displayName);
}

/* -------------------------------------------------------------------------- */
/* US1 — creation, ordering and activation                                    */
/* -------------------------------------------------------------------------- */

describe("DocumentManager creation and tab order (US1)", () => {
  it("starts with exactly one active Untitled1 session", () => {
    const { manager } = createHarness();
    const snapshot = manager.getSnapshot();

    expect(snapshot.tabs).toHaveLength(1);
    expect(snapshot.tabs[0].displayName).toBe("Untitled1");
    expect(snapshot.tabs[0].path).toBeNull();
    expect(snapshot.tabs[0].dirty).toBe(false);
    expect(snapshot.tabs[0].active).toBe(true);
    expect(snapshot.activeDocumentId).toBe(snapshot.tabs[0].id);

    expect(manager.listSessions()).toHaveLength(1);
    expect(manager.getActiveSession().id).toBe(snapshot.tabs[0].id);
    expect(manager.getSession(snapshot.tabs[0].id)?.displayName).toBe(
      "Untitled1",
    );
  });

  it("appends and activates new untitled documents without disturbing earlier ones", () => {
    const { manager } = createHarness();
    const first = manager.getActiveSession().id;

    const second = manager.createUntitled();
    const third = manager.createUntitled();

    expect(tabNames(manager.getSnapshot())).toEqual([
      "Untitled1",
      "Untitled2",
      "Untitled3",
    ]);
    expect(manager.getSnapshot().activeDocumentId).toBe(third);
    expect(manager.getSession(first)?.displayName).toBe("Untitled1");
    expect(manager.getSession(second)?.displayName).toBe("Untitled2");
    expect(manager.listSessions().map((session) => session.id)).toEqual([
      first,
      second,
      third,
    ]);
  });

  it("keeps tab order stable when an earlier document is activated again", () => {
    const { manager } = createHarness();
    const first = manager.getActiveSession().id;
    const second = manager.createUntitled();
    const third = manager.createUntitled();

    manager.activateDocument(first);

    expect(manager.listSessions().map((session) => session.id)).toEqual([
      first,
      second,
      third,
    ]);
    expect(manager.getSnapshot().activeDocumentId).toBe(first);
    expect(
      manager.getSnapshot().tabs.map((tab) => tab.active),
    ).toEqual([true, false, false]);
  });

  it("ignores activation of an id that is not open", () => {
    const { manager } = createHarness();
    const active = manager.getSnapshot().activeDocumentId;

    manager.activateDocument("doc-does-not-exist");

    expect(manager.getSnapshot().activeDocumentId).toBe(active);
  });

  it("gives every session a distinct stable identity", () => {
    const { manager } = createHarness();
    const ids = [
      manager.getActiveSession().id,
      manager.createUntitled(),
      manager.createUntitled(),
    ];

    expect(new Set(ids).size).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* US1 — editor update ingress                                                */
/* -------------------------------------------------------------------------- */

describe("DocumentManager editor update routing (US1)", () => {
  it("updates only the session named by the callback document id", () => {
    const { manager, editor } = createHarness();
    const first = manager.getActiveSession().id;
    const second = manager.createUntitled();

    const stateA2 = EditorState.create({ doc: toText("alpha") });
    const stateB = manager.getSession(second)!.editorState;

    manager.handleEditorStateUpdate(first, stateA2, true);

    expect(manager.getSession(first)!.editorState).toBe(stateA2);
    expect(manager.getSession(second)!.editorState).toBe(stateB);
    expect(manager.getSession(second)!.dirty).toBe(false);
    expect(editor.read()).toBe("");
  });

  it("stores the newest state on a cursor-only update without emitting a snapshot", () => {
    const { manager, editor, emissions } = createHarness();
    const id = manager.getActiveSession().id;

    editor.type("alpha");
    const afterTyping = manager.getSession(id)!.editorState;
    const emissionsAfterTyping = emissions();

    editor.moveCursor();

    const afterCursor = manager.getSession(id)!.editorState;
    expect(afterCursor).not.toBe(afterTyping);
    expect(afterCursor.doc.eq(afterTyping.doc)).toBe(true);
    expect(emissions()).toBe(emissionsAfterTyping);
  });

  it("emits one snapshot when a document becomes dirty and none while it stays dirty", () => {
    const { manager, editor, emissions } = createHarness();
    const id = manager.getActiveSession().id;

    expect(manager.getSession(id)!.dirty).toBe(false);
    const before = emissions();

    editor.type("a");
    expect(manager.getSession(id)!.dirty).toBe(true);
    expect(emissions()).toBe(before + 1);

    editor.type("ab");
    editor.type("abc");
    expect(manager.getSession(id)!.dirty).toBe(true);
    expect(emissions()).toBe(before + 1);
  });

  it("returns a document to clean when its state matches the saved baseline again", () => {
    const { manager, editor, emissions } = createHarness();
    const id = manager.getActiveSession().id;
    const baselineEmissions = emissions();

    editor.type("alpha");
    expect(manager.getSession(id)!.dirty).toBe(true);

    editor.applyHistory("");

    expect(manager.getSession(id)!.dirty).toBe(false);
    expect(manager.getSnapshot().tabs[0].dirty).toBe(false);
    expect(emissions()).toBe(baselineEmissions + 2);
  });

  it("ignores an update for a document id that is not open", () => {
    const { manager, emissions } = createHarness();
    const active = manager.getActiveSession().id;
    const before = manager.getSession(active)!.editorState;
    const emissionsBefore = emissions();

    manager.handleEditorStateUpdate(
      "doc-not-open",
      EditorState.create({ doc: toText("orphan") }),
      true,
    );

    expect(manager.getSession(active)!.editorState).toBe(before);
    expect(emissions()).toBe(emissionsBefore);
  });

  it("binds the target document id before installing its state", () => {
    const { manager, editor } = createHarness();
    const seen: DocumentId[] = [];
    editor.setStateUpdateListener((documentId, state, docChanged) => {
      seen.push(documentId);
      manager.handleEditorStateUpdate(documentId, state, docChanged);
    });

    const second = manager.createUntitled();

    expect(seen[seen.length - 1]).toBe(second);
  });
});

/* -------------------------------------------------------------------------- */
/* US1 — activation and view state                                            */
/* -------------------------------------------------------------------------- */

describe("DocumentManager activation and view state (US1)", () => {
  it("captures the outgoing view state and restores the target's", () => {
    const { manager, editor } = createHarness();
    const first = manager.getActiveSession().id;
    const second = manager.createUntitled();

    editor.scroll = { scrollTop: 120, scrollLeft: 8 };
    manager.activateDocument(first);

    expect(manager.getSession(second)!.viewState).toEqual({
      scrollTop: 120,
      scrollLeft: 8,
    });

    editor.scroll = { scrollTop: 999, scrollLeft: 3 };
    manager.activateDocument(second);

    expect(manager.getSession(first)!.viewState).toEqual({
      scrollTop: 999,
      scrollLeft: 3,
    });
    expect(editor.scroll).toEqual({ scrollTop: 120, scrollLeft: 8 });
  });

  it("installs the target session's state into the shared view", () => {
    const { manager, editor } = createHarness();
    const first = manager.getActiveSession().id;
    const second = manager.createUntitled();

    const firstState = manager.getSession(first)!.editorState;
    manager.activateDocument(first);

    expect(editor.setStateCalls[editor.setStateCalls.length - 1]).toEqual({
      documentId: first,
      state: firstState,
    });
    expect(editor.boundDocumentId).toBe(first);

    const secondState = manager.getSession(second)!.editorState;
    manager.activateDocument(second);

    expect(editor.setStateCalls[editor.setStateCalls.length - 1]).toEqual({
      documentId: second,
      state: secondState,
    });
    expect(editor.boundDocumentId).toBe(second);
  });

  it("focuses the editor when a document is activated or re-selected", () => {
    const { manager, editor } = createHarness();
    const first = manager.getActiveSession().id;
    const second = manager.createUntitled();

    manager.activateDocument(second);
    const afterCreate = editor.focusCount;

    manager.activateDocument(first);
    expect(editor.focusCount).toBe(afterCreate + 1);

    manager.activateDocument(first);
    expect(editor.focusCount).toBe(afterCreate + 2);
  });

  it("does not touch an editor that is not attached yet", () => {
    const { manager, editor } = createHarness();
    const first = manager.getActiveSession().id;
    editor.ready = false;
    editor.setStateUpdateListener(null);
    const setStatesBefore = editor.setStateCalls.length;
    const focusBefore = editor.focusCount;

    expect(() => {
      manager.createUntitled();
      manager.activateDocument(first);
    }).not.toThrow();

    expect(editor.setStateCalls).toHaveLength(setStatesBefore);
    expect(editor.focusCount).toBe(focusBefore);
    expect(manager.getSnapshot().tabs).toHaveLength(2);
    expect(manager.getSnapshot().activeDocumentId).toBe(first);
  });

  it("does not emit a snapshot when the requested document is already active", () => {
    const { manager, emissions } = createHarness();
    const active = manager.getActiveSession().id;
    const before = emissions();

    manager.activateDocument(active);

    expect(emissions()).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* US2 — opening files without duplicates                                     */
/* -------------------------------------------------------------------------- */

const SMALL_A = "C:\\work\\a.txt";
const SMALL_B = "C:\\work\\b.txt";

describe("DocumentManager open (US2)", () => {
  it("opens a file as a new active Tab without replacing existing documents", async () => {
    const { manager, files } = createHarness();
    files.addFile(SMALL_A, "alpha");

    const first = manager.getActiveSession().id;
    const result = await manager.openPath(SMALL_A);

    expect(result.status).toBe("opened");
    const openedId = result.status === "opened" ? result.documentId : "";
    expect(openedId).not.toBe(first);

    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1", "a.txt"]);
    expect(manager.getSnapshot().activeDocumentId).toBe(openedId);
    expect(manager.getSession(first)).toBeDefined();

    const opened = manager.getSession(openedId)!;
    expect(opened.path).toBe(SMALL_A);
    expect(opened.displayName).toBe("a.txt");
    expect(opened.dirty).toBe(false);
    expect(opened.editorState.doc.toString()).toBe("alpha");
    expect(opened.pathIdentity?.comparisonKey).toBe(
      files.comparisonKeyFor(SMALL_A),
    );
  });

  it("activates the existing session instead of reading the file a second time", async () => {
    const { manager, files } = createHarness();
    files.addFile(SMALL_A, "alpha");

    const first = await manager.openPath(SMALL_A);
    const readsAfterFirstOpen = files.reads.length;

    const second = await manager.openPath(SMALL_A);

    expect(second.status).toBe("activated-existing");
    expect(second).toEqual({
      status: "activated-existing",
      documentId: first.status === "opened" ? first.documentId : "",
    });
    expect(files.reads).toHaveLength(readsAfterFirstOpen);
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1", "a.txt"]);
  });

  it("recognizes an equivalent spelling of an already-open path", async () => {
    const { manager, files } = createHarness();
    files.addFile(SMALL_A, "alpha");
    // A second spelling that resolves to the same canonical object.
    files.alias("C:\\work\\.\\a.txt", SMALL_A);

    const opened = await manager.openPath(SMALL_A);
    const duplicate = await manager.openPath("C:\\work\\.\\a.txt");

    expect(duplicate.status).toBe("activated-existing");
    expect(duplicate).toEqual({
      status: "activated-existing",
      documentId: opened.status === "opened" ? opened.documentId : "",
    });
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1", "a.txt"]);
  });

  it("keeps two same-named files from different directories as separate Tabs", async () => {
    const { manager, files } = createHarness();
    files.addFile("C:\\one\\notes.txt", "one");
    files.addFile("C:\\two\\notes.txt", "two");

    const one = await manager.openPath("C:\\one\\notes.txt");
    const two = await manager.openPath("C:\\two\\notes.txt");

    expect(one.status).toBe("opened");
    expect(two.status).toBe("opened");
    expect(tabNames(manager.getSnapshot())).toEqual([
      "Untitled1",
      "notes.txt",
      "notes.txt",
    ]);
    expect(
      manager.getSnapshot().tabs.map((tab) => tab.path),
    ).toEqual([null, "C:\\one\\notes.txt", "C:\\two\\notes.txt"]);
  });

  it("creates no session when reading or decoding fails", async () => {
    const { manager, files, dialogs } = createHarness();
    files.addUnreadableFile("C:\\work\\binary.bin", {
      code: "unsupported_binary",
      message: "The file contains binary data.",
    });

    const result = await manager.openPath("C:\\work\\binary.bin");

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "unsupported_binary",
        message: "The file contains binary data.",
      },
    });
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1"]);
    expect(dialogs.errors).toEqual(["The file contains binary data."]);
  });

  it("creates no session when the path cannot be resolved", async () => {
    const { manager, files, dialogs } = createHarness();

    const result = await manager.openPath("C:\\work\\does-not-exist.txt");

    expect(result.status).toBe("failed");
    expect(
      result.status === "failed" ? result.error.code : undefined,
    ).toBe("path_resolution");
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1"]);
    expect(files.reads).toHaveLength(0);
    expect(dialogs.errors).toHaveLength(1);
  });

  it("ignores a directory drop target but reports a directory open request", async () => {
    const { manager, files, dialogs } = createHarness();
    files.addDirectory("C:\\work\\folder");

    const ignored = await manager.openPath("C:\\work\\folder", {
      ignoreDirectories: true,
    });
    expect(ignored).toEqual({ status: "ignored-directory" });
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1"]);
    expect(dialogs.errors).toHaveLength(0);

    const reported = await manager.openPath("C:\\work\\folder");
    expect(reported.status).toBe("failed");
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1"]);
    expect(dialogs.errors).toHaveLength(1);
    expect(files.reads).toHaveLength(0);
  });

  it("returns cancelled and changes nothing when the picker is dismissed", async () => {
    const { manager, files, dialogs } = createHarness();
    dialogs.openPath = null;

    const result = await manager.openFromDialog();

    expect(result).toEqual({ status: "cancelled" });
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1"]);
    expect(files.reads).toHaveLength(0);
    expect(files.inspections).toHaveLength(0);
    expect(dialogs.errors).toHaveLength(0);
  });

  it("opens the path chosen in the picker", async () => {
    const { manager, files, dialogs } = createHarness();
    files.addFile(SMALL_B, "bravo");
    dialogs.openPath = SMALL_B;

    const result = await manager.openFromDialog();

    expect(result.status).toBe("opened");
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1", "b.txt"]);
  });

  it("never prompts about unsaved work merely because another document opens", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.editor.type("dirty work");
    expect(harness.manager.getActiveSession().dirty).toBe(true);

    harness.manager.createUntitled();
    await harness.manager.openPath(SMALL_A);

    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "Untitled2",
      "a.txt",
    ]);
  });

  it("focuses the editor after a successful open", async () => {
    const { manager, files, editor } = createHarness();
    files.addFile(SMALL_A, "alpha");
    const focusBefore = editor.focusCount;

    await manager.openPath(SMALL_A);

    expect(editor.focusCount).toBe(focusBefore + 1);
  });

  it("does not prompt or create a Tab when inspection fails", async () => {
    const { manager, files, dialogs } = createHarness();
    files.inspectError = { code: "io_read", message: "IPC transport unavailable" };

    const result = await manager.openPath(SMALL_A);

    expect(result.status).toBe("failed");
    expect(dialogs.errors).toEqual(["IPC transport unavailable"]);
    expect(tabNames(manager.getSnapshot())).toEqual(["Untitled1"]);
  });

  it("produces exactly one session for two overlapping opens of one path", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.files.holdReads = true;

    const first = harness.manager.openPath(SMALL_A);
    const second = harness.manager.openPath(SMALL_A);
    await flush();

    // The second request waited for the first instead of reading again, and the
    // destination was reserved for the whole in-flight open.
    expect(harness.files.reads).toHaveLength(1);
    expect(harness.files.pendingReadCount()).toBe(1);

    harness.files.releaseReads();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("opened");
    expect(secondResult.status).toBe("activated-existing");
    if (
      firstResult.status !== "opened" ||
      secondResult.status !== "activated-existing"
    ) {
      throw new Error("Both concurrent opens must succeed.");
    }

    expect(secondResult.documentId).toBe(firstResult.documentId);
    expect(harness.manager.listSessions()).toHaveLength(2);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "a.txt",
    ]);
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(
      firstResult.documentId,
    );
  });

  it("releases the open reservation when the in-flight read fails", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.files.readError = {
      code: "unsupported_binary",
      message: "The file contains binary data.",
    };

    const first = await harness.manager.openPath(SMALL_A);
    expect(first.status).toBe("failed");

    // The next request must start a fresh read rather than await a stale one.
    harness.files.readError = null;
    const second = await harness.manager.openPath(SMALL_A);

    expect(second.status).toBe("opened");
    expect(harness.files.reads).toHaveLength(2);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "a.txt",
    ]);
  });
});


/* -------------------------------------------------------------------------- */
/* US1 — snapshot projection                                                  */
/* -------------------------------------------------------------------------- */

describe("DocumentManager snapshot projection (US1)", () => {
  it("carries tab metadata only and never editor state or text", () => {
    const { manager } = createHarness();
    manager.createUntitled();

    const snapshot = manager.getSnapshot();

    expect(Object.keys(snapshot).sort()).toEqual([
      "activeDocumentId",
      "tabs",
    ]);
    for (const tab of snapshot.tabs) {
      expect(Object.keys(tab).sort()).toEqual([
        "active",
        "dirty",
        "displayName",
        "id",
        "path",
      ]);
    }
    expect(JSON.stringify(snapshot)).not.toContain("editorState");
  });

  it("hands every listener the same lightweight projection", () => {
    const { manager, snapshots } = createHarness();

    manager.createUntitled();

    expect(snapshots).toHaveLength(1);
    expect(tabNames(snapshots[0])).toEqual(["Untitled1", "Untitled2"]);
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const { manager } = createHarness();
    const seen: DocumentManagerSnapshot[] = [];
    const unsubscribe = manager.subscribe((snapshot) => {
      seen.push(snapshot);
    });

    manager.createUntitled();
    expect(seen).toHaveLength(1);

    unsubscribe();
    manager.createUntitled();
    expect(seen).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* US3 — save                                                                 */
/* -------------------------------------------------------------------------- */

/** Lets every already-queued microtask chain run up to its next real await. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function openSmallA(harness: Harness, text = "alpha"): Promise<DocumentId> {
  harness.files.addFile(SMALL_A, text);
  const opened = await harness.manager.openPath(SMALL_A);
  if (opened.status !== "opened") {
    throw new Error(`Expected ${SMALL_A} to open.`);
  }
  return opened.documentId;
}

describe("DocumentManager save (US3)", () => {
  it("treats a save for a document that is not open as a no-op", async () => {
    const { manager, files } = createHarness();

    await expect(manager.saveDocument("doc-not-open")).resolves.toEqual({
      status: "success",
    });
    expect(files.writes).toHaveLength(0);
  });

  it("does not rewrite a clean document", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });
    expect(harness.files.writes).toHaveLength(0);
  });

  it("saves an inactive document from its own state and destination", async () => {
    const harness = createHarness();
    const idA = await openSmallA(harness);
    harness.editor.type("edited A");
    expect(harness.manager.getSession(idA)!.dirty).toBe(true);

    const idB = harness.manager.createUntitled();
    harness.editor.type("draft B");
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(idB);

    await expect(harness.manager.saveDocument(idA)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0]).toMatchObject({
      path: SMALL_A,
      text: "edited A",
      bom: "none",
      lineEnding: "crlf",
    });
    expect(harness.manager.getSession(idA)!.dirty).toBe(false);
    // The inactive save never activated A and never touched B.
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(idB);
    expect(harness.manager.getSession(idB)!.dirty).toBe(true);
    expect(harness.manager.getSession(idB)!.savedBaseline.toString()).toBe("");
  });

  it("does not let a delayed save of A mutate B", async () => {
    const harness = createHarness();
    const idA = await openSmallA(harness);
    harness.editor.type("edited A");
    harness.files.holdWrites = true;

    const savingA = harness.manager.saveDocument(idA);
    await flush();

    const idB = harness.manager.createUntitled();
    harness.editor.type("draft B");

    harness.files.releaseWrites();
    await expect(savingA).resolves.toEqual({ status: "success" });

    expect(harness.manager.getSession(idA)!.dirty).toBe(false);
    expect(harness.manager.getSession(idB)!.dirty).toBe(true);
    expect(harness.manager.getSession(idB)!.editorState.doc.toString()).toBe(
      "draft B",
    );
  });

  it("issues same-path writes in order", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);

    harness.editor.type("first");
    harness.files.holdWrites = true;
    const firstSave = harness.manager.saveDocument(id);
    await flush();

    harness.editor.type("second");
    const secondSave = harness.manager.saveDocument(id);
    await flush();

    // The second write must wait for the first one to hit the disk.
    expect(harness.files.pendingWriteCount()).toBe(1);

    harness.files.releaseNextWrite();
    await firstSave;
    await flush();

    expect(harness.files.pendingWriteCount()).toBe(1);
    harness.files.releaseNextWrite();
    await secondSave;

    expect(harness.files.writes.map((write) => write.text)).toEqual([
      "first",
      "second",
    ]);
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });

  it("recomputes dirty against the captured snapshot, not the live document", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);

    harness.editor.type("one");
    harness.files.holdWrites = true;
    const saving = harness.manager.saveDocument(id);
    await flush();

    harness.editor.type("one plus more");
    harness.files.releaseWrites();
    await saving;

    expect(harness.manager.getSession(id)!.savedBaseline.toString()).toBe(
      "one",
    );
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
    expect(harness.manager.getSnapshot().tabs[1].dirty).toBe(true);
  });

  it("keeps the old baseline and reports the failure when the write fails", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);

    harness.editor.type("edited");
    harness.files.writeError = { code: "io_write", message: "disk full" };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "failed",
      error: { code: "io_write", message: "disk full" },
    });

    expect(harness.dialogs.errors).toEqual(["disk full"]);
    expect(harness.manager.getSession(id)!.savedBaseline.toString()).toBe(
      "alpha",
    );
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
    expect(harness.manager.getSession(id)!.path).toBe(SMALL_A);
  });

  it("ignores a save completion whose document was closed in flight", async () => {
    const harness = createHarness();
    const idA = await openSmallA(harness);
    harness.editor.type("edited A");
    const idB = harness.manager.createUntitled();

    harness.files.holdWrites = true;
    const saving = harness.manager.saveDocument(idA);
    await flush();

    harness.dialogs.unsavedChoice = "dontSave";
    await expect(harness.manager.closeDocument(idA)).resolves.toEqual({
      status: "closed",
    });
    expect(harness.manager.getSession(idA)).toBeUndefined();

    const activeBefore = harness.manager.getSession(idB)!.editorState;
    const writesBefore = harness.files.writes.length;

    harness.files.releaseWrites();
    await expect(saving).resolves.toEqual({ status: "success" });

    // The bytes still landed, but no surviving session was mutated.
    expect(harness.files.writes).toHaveLength(writesBefore);
    expect(harness.manager.getSession(idB)!.editorState).toBe(activeBefore);
    expect(harness.manager.getSession(idB)!.dirty).toBe(false);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "Untitled2",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* US3 — Save As                                                              */
/* -------------------------------------------------------------------------- */

describe("DocumentManager save as (US3)", () => {
  it("delegates Save on an untitled document to Save As", async () => {
    const harness = createHarness();
    const id = harness.manager.getActiveSession().id;
    harness.editor.type("draft");
    harness.dialogs.savePath = "C:\\work\\draft.txt";

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes[0]).toMatchObject({
      path: "C:\\work\\draft.txt",
      text: "draft",
    });
    expect(harness.manager.getSession(id)!.path).toBe("C:\\work\\draft.txt");
    expect(harness.manager.getSession(id)!.displayName).toBe("draft.txt");
    expect(harness.manager.getSnapshot().tabs[0].displayName).toBe("draft.txt");
  });

  it("reports a cancelled Save As without changing the document", async () => {
    const harness = createHarness();
    const id = harness.manager.getActiveSession().id;
    harness.editor.type("draft");
    harness.dialogs.savePath = null;

    await expect(harness.manager.saveDocumentAs(id)).resolves.toEqual({
      status: "cancelled",
    });

    expect(harness.manager.getSession(id)!.path).toBeNull();
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
    expect(harness.files.writes).toHaveLength(0);
  });

  it("rejects a target another document already owns", async () => {
    const harness = createHarness();
    await openSmallA(harness);
    const idB = harness.manager.createUntitled();
    harness.editor.type("draft B");

    harness.dialogs.savePath = SMALL_A;
    const result = await harness.manager.saveDocumentAs(idB);

    expect(result.status).toBe("failed");
    expect(harness.dialogs.errors).toHaveLength(1);
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.manager.getSession(idB)!.path).toBeNull();
    expect(harness.manager.getSession(idB)!.dirty).toBe(true);
    expect(harness.manager.getSession(idB)!.displayName).toBe("Untitled2");
  });

  it("allows a document to target the path it already owns", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("changed");

    harness.dialogs.savePath = SMALL_A;
    await expect(harness.manager.saveDocumentAs(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.manager.getSession(id)!.path).toBe(SMALL_A);
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });

  it("rejects a target that is only claimed by an in-flight Save As", async () => {
    const harness = createHarness();
    const idA = harness.manager.getActiveSession().id;
    harness.editor.type("draft A");
    const idB = harness.manager.createUntitled();
    harness.editor.type("draft B");

    harness.dialogs.savePath = "C:\\work\\shared.txt";
    harness.files.holdWrites = true;
    const savingA = harness.manager.saveDocumentAs(idA);
    await flush();

    const savingB = harness.manager.saveDocumentAs(idB);
    await flush();

    // Only A ever reached the disk.
    expect(harness.files.writes).toHaveLength(1);

    harness.files.releaseWrites();
    await expect(savingA).resolves.toEqual({ status: "success" });
    await expect(savingB).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "path_resolution" }),
    });

    expect(harness.manager.getSession(idA)!.path).toBe("C:\\work\\shared.txt");
    expect(harness.manager.getSession(idB)!.path).toBeNull();
  });

  it("does not let a stale Save As completion replace a newer target", async () => {
    const harness = createHarness();
    const id = harness.manager.getActiveSession().id;
    harness.editor.type("draft");

    harness.files.holdWrites = true;
    harness.dialogs.savePath = "C:\\work\\X.txt";
    const savingX = harness.manager.saveDocumentAs(id);
    await flush();

    harness.dialogs.savePath = "C:\\work\\Y.txt";
    const savingY = harness.manager.saveDocumentAs(id);
    await flush();

    // Y finishes first and becomes the document's decision...
    harness.files.releaseLastWrite();
    await expect(savingY).resolves.toEqual({ status: "success" });
    expect(harness.manager.getSession(id)!.path).toBe("C:\\work\\Y.txt");

    // ...so the older completion must not move the document back to X.
    harness.files.releaseNextWrite();
    await expect(savingX).resolves.toEqual({ status: "success" });

    expect(harness.manager.getSession(id)!.path).toBe("C:\\work\\Y.txt");
    expect(harness.manager.getSession(id)!.displayName).toBe("Y.txt");
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });

  it("releases the target claim when the write fails", async () => {
    const harness = createHarness();
    const idA = harness.manager.getActiveSession().id;
    harness.editor.type("draft A");

    harness.dialogs.savePath = "C:\\work\\target.txt";
    harness.files.writeError = { code: "io_write", message: "disk full" };
    expect((await harness.manager.saveDocumentAs(idA)).status).toBe("failed");

    // A different document may now claim the same destination.
    harness.files.writeError = null;
    const idB = harness.manager.createUntitled();
    harness.editor.type("draft B");
    harness.dialogs.savePath = "C:\\work\\target.txt";

    await expect(harness.manager.saveDocumentAs(idB)).resolves.toEqual({
      status: "success",
    });
    expect(harness.manager.getSession(idB)!.path).toBe("C:\\work\\target.txt");
  });

  it("moves path ownership only after the relevant Save As succeeds", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("changed");

    harness.dialogs.savePath = "C:\\work\\new.txt";
    harness.files.holdWrites = true;
    const saving = harness.manager.saveDocumentAs(id);
    await flush();

    // While the write is in flight the old identity is still owned by `id`.
    expect(harness.manager.getSession(id)!.path).toBe(SMALL_A);
    expect(harness.manager.getSession(id)!.pathIdentity?.comparisonKey).toBe(
      harness.files.comparisonKeyFor(SMALL_A),
    );

    harness.files.releaseWrites();
    await saving;

    expect(harness.manager.getSession(id)!.path).toBe("C:\\work\\new.txt");
    expect(harness.manager.getSession(id)!.pathIdentity?.comparisonKey).toBe(
      harness.files.comparisonKeyFor("C:\\work\\new.txt"),
    );

    // The old path is free again, so opening it creates a second session.
    const reopened = await harness.manager.openPath(SMALL_A);
    expect(reopened.status).toBe("opened");
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "new.txt",
      "a.txt",
    ]);
  });

  it("serializes writes that name one destination through equivalent spellings", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const alias = "C:\\work\\.\\a.txt";
    // A spelling that resolves to the same filesystem object.
    harness.files.alias(alias, SMALL_A);
    expect(harness.files.comparisonKeyFor(alias)).toBe(
      harness.files.comparisonKeyFor(SMALL_A),
    );

    harness.editor.type("first");
    harness.files.holdWrites = true;
    const firstSave = harness.manager.saveDocument(id);
    await flush();

    harness.editor.type("second");
    harness.dialogs.savePath = alias;
    const secondSave = harness.manager.saveDocumentAs(id);
    await flush();

    // Both writes target one destination, so the second must queue behind the
    // first even though the paths are spelled differently.
    expect(harness.files.pendingWriteCount()).toBe(1);

    harness.files.releaseNextWrite();
    await firstSave;
    await flush();

    expect(harness.files.pendingWriteCount()).toBe(1);
    harness.files.releaseNextWrite();
    await secondSave;

    expect(harness.files.writes.map((write) => write.text)).toEqual([
      "first",
      "second",
    ]);
    expect(harness.manager.getSession(id)!.path).toBe(alias);
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });

  it("keeps a renewed reservation when an older completion arrives stale", async () => {
    const harness = createHarness();
    const idA = harness.manager.getActiveSession().id;
    harness.editor.type("draft A");
    const idB = harness.manager.createUntitled();
    harness.editor.type("draft B");

    const target = "C:\\work\\shared.txt";
    const key = harness.files.comparisonKeyFor(target);

    harness.files.holdWrites = true;
    harness.dialogs.savePath = target;
    const firstSave = harness.manager.saveDocumentAs(idA);
    await flush();

    // The same document renews the same destination while the first is in
    // flight, replacing the reservation with its own generation.
    harness.dialogs.savePath = target;
    const secondSave = harness.manager.saveDocumentAs(idA);
    await flush();

    harness.dialogs.savePath = target;
    await expect(harness.manager.saveDocumentAs(idB)).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "path_resolution" }),
    });

    // The older write completes stale; the newer one is still queued behind it.
    harness.files.releaseNextWrite();
    await expect(firstSave).resolves.toEqual({ status: "success" });
    await flush();
    expect(harness.files.pendingWriteCount()).toBe(1);

    // The stale completion must not have released the renewed reservation.
    harness.dialogs.savePath = target;
    await expect(harness.manager.saveDocumentAs(idB)).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "path_resolution" }),
    });

    harness.files.releaseNextWrite();
    await expect(secondSave).resolves.toEqual({ status: "success" });

    const owners = harness.manager
      .listSessions()
      .filter((session) => session.pathIdentity?.comparisonKey === key);
    expect(owners).toHaveLength(1);
    expect(owners[0].id).toBe(idA);
    expect(harness.manager.getSession(idA)!.path).toBe(target);
    expect(harness.manager.getSession(idB)!.path).toBeNull();
  });

  it("keeps the previous path when the Save As target is rejected", async () => {    const harness = createHarness();
    const id = await openSmallA(harness);
    const untouched = harness.manager.createUntitled();

    harness.dialogs.savePath = SMALL_A;
    harness.editor.type("changed");
    const result = await harness.manager.saveDocumentAs(id);

    // `id` may target its own path, so this succeeds; the other document may not.
    expect(result.status).toBe("success");

    harness.dialogs.savePath = SMALL_A;
    harness.editor.type("draft");
    const rejected = await harness.manager.saveDocumentAs(untouched);
    expect(rejected.status).toBe("failed");
    expect(harness.manager.getSession(untouched)!.path).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* US3 — close                                                                */
/* -------------------------------------------------------------------------- */

describe("DocumentManager close (US3)", () => {
  it("closes a clean Tab without prompting", async () => {
    const harness = createHarness();
    const keep = harness.manager.getActiveSession().id;
    const id = harness.manager.createUntitled();

    await expect(harness.manager.closeDocument(id)).resolves.toEqual({
      status: "closed",
    });

    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(tabNames(harness.manager.getSnapshot())).toEqual(["Untitled1"]);
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(keep);
  });

  it("keeps a dirty Tab open when the guard is cancelled", async () => {
    const harness = createHarness();
    const id = harness.manager.getActiveSession().id;
    harness.editor.type("dirty");
    harness.dialogs.unsavedChoice = "cancel";

    await expect(harness.manager.closeDocument(id)).resolves.toEqual({
      status: "cancelled",
    });

    expect(harness.manager.getSession(id)).toBeDefined();
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(id);
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
    expect(harness.files.writes).toHaveLength(0);
  });

  it("closes a dirty Tab without writing when the user declines", async () => {
    const harness = createHarness();
    const id = harness.manager.getActiveSession().id;
    harness.editor.type("dirty");
    harness.dialogs.unsavedChoice = "dontSave";

    await expect(harness.manager.closeDocument(id)).resolves.toEqual({
      status: "closed",
    });

    expect(harness.manager.getSession(id)).toBeUndefined();
    expect(harness.files.writes).toHaveLength(0);
    // Normal last-Tab close replaces the document.
    expect(tabNames(harness.manager.getSnapshot())).toEqual(["Untitled2"]);
  });

  it("saves before closing when the user chooses Save", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("edited");
    harness.dialogs.unsavedChoice = "save";

    await expect(harness.manager.closeDocument(id)).resolves.toEqual({
      status: "closed",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0].text).toBe("edited");
    expect(harness.manager.getSession(id)).toBeUndefined();
  });

  it("keeps the Tab open when the chosen save fails", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("edited");
    harness.dialogs.unsavedChoice = "save";
    harness.files.writeError = { code: "io_write", message: "disk full" };

    const result = await harness.manager.closeDocument(id);

    expect(result).toEqual({
      status: "failed",
      error: { code: "io_write", message: "disk full" },
    });
    expect(harness.manager.getSession(id)).toBeDefined();
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
  });

  it("keeps the Tab open when Save As is cancelled during close", async () => {
    const harness = createHarness();
    const id = harness.manager.getActiveSession().id;
    harness.editor.type("dirty");
    harness.dialogs.unsavedChoice = "save";
    harness.dialogs.savePath = null;

    await expect(harness.manager.closeDocument(id)).resolves.toEqual({
      status: "cancelled",
    });

    expect(harness.manager.getSession(id)).toBeDefined();
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
  });

  it("closes an inactive dirty Tab without activating it", async () => {
    const harness = createHarness();
    const first = harness.manager.getActiveSession().id;
    harness.editor.type("dirty first");
    const second = harness.manager.createUntitled();
    harness.dialogs.unsavedChoice = "dontSave";

    await expect(harness.manager.closeDocument(first)).resolves.toEqual({
      status: "closed",
    });

    expect(harness.dialogs.unsavedPrompts).toEqual(["Untitled1"]);
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(second);
    expect(harness.manager.getSession(first)).toBeUndefined();
  });

  it("keeps the active Tab unchanged when an inactive close is cancelled", async () => {
    const harness = createHarness();
    const first = harness.manager.getActiveSession().id;
    harness.editor.type("dirty first");
    const second = harness.manager.createUntitled();
    harness.dialogs.unsavedChoice = "cancel";

    await expect(harness.manager.closeDocument(first)).resolves.toEqual({
      status: "cancelled",
    });

    expect(harness.manager.getSession(first)).toBeDefined();
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(second);
  });

  it("activates the left neighbour after closing the active Tab", async () => {
    const harness = createHarness();
    const first = harness.manager.getActiveSession().id;
    const second = harness.manager.createUntitled();
    const third = harness.manager.createUntitled();

    await harness.manager.closeDocument(third);

    expect(harness.manager.getSnapshot().activeDocumentId).toBe(second);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "Untitled2",
    ]);
    expect(harness.manager.getSession(first)).toBeDefined();
  });

  it("activates the new first Tab after closing the first Tab", async () => {
    const harness = createHarness();
    const first = harness.manager.getActiveSession().id;
    const second = harness.manager.createUntitled();
    harness.manager.createUntitled();

    harness.manager.activateDocument(first);
    await harness.manager.closeDocument(first);

    expect(harness.manager.getSnapshot().activeDocumentId).toBe(second);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled2",
      "Untitled3",
    ]);
  });

  it("creates the next UntitledN after the final Tab closes", async () => {
    const harness = createHarness();
    const only = harness.manager.getActiveSession().id;

    await expect(harness.manager.closeDocument(only)).resolves.toEqual({
      status: "closed",
    });

    expect(tabNames(harness.manager.getSnapshot())).toEqual(["Untitled2"]);
    expect(harness.manager.getSession(only)).toBeUndefined();
    expect(harness.manager.getActiveSession().dirty).toBe(false);
  });

  it("never reuses an Untitled number after Save As and close", async () => {
    const harness = createHarness();
    const first = harness.manager.getActiveSession().id;
    harness.manager.createUntitled();
    harness.dialogs.savePath = "C:\\work\\a.txt";
    await harness.manager.saveDocumentAs(first);
    await harness.manager.closeDocument(first);

    const fresh = harness.manager.createUntitled();

    expect(harness.manager.getSession(fresh)!.displayName).toBe("Untitled3");
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled2",
      "Untitled3",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* US3 — window close                                                         */
/* -------------------------------------------------------------------------- */

type Decision = "save" | "dontSave";

/** All eight completing Save / Don't Save sequences for three dirty documents. */
function completingSequences(): Decision[][] {
  const sequences: Decision[][] = [];
  for (let mask = 0; mask < 8; mask += 1) {
    sequences.push(
      [0, 1, 2].map((index) =>
        (mask & (1 << index)) === 0 ? "save" : "dontSave",
      ),
    );
  }
  return sequences;
}

interface AbortCase {
  prefix: Decision[];
  position: number;
  outcome: "cancel" | "failure";
}

/**
 * The fourteen aborting sequences: Cancel or a save failure at every document
 * position, after every allowed Save / Don't Save prefix.
 */
function abortingSequences(): AbortCase[] {
  const cases: AbortCase[] = [];
  for (let position = 0; position < 3; position += 1) {
    for (let mask = 0; mask < 1 << position; mask += 1) {
      const prefix: Decision[] = [];
      for (let index = 0; index < position; index += 1) {
        prefix.push((mask & (1 << index)) === 0 ? "save" : "dontSave");
      }
      for (const outcome of ["cancel", "failure"] as const) {
        cases.push({ prefix, position, outcome });
      }
    }
  }
  return cases;
}

/** Three dirty documents, in Tab order. */
function createDirtyHarness(): Harness & { ids: DocumentId[] } {
  const harness = createHarness();
  const ids: DocumentId[] = [harness.manager.getActiveSession().id];
  harness.editor.type("draft 0");
  for (let index = 1; index < 3; index += 1) {
    ids.push(harness.manager.createUntitled());
    harness.editor.type(`draft ${index}`);
  }
  harness.dialogs.savePaths = [
    "C:\\work\\saved-0.txt",
    "C:\\work\\saved-1.txt",
    "C:\\work\\saved-2.txt",
  ];
  return { ...harness, ids };
}

describe("DocumentManager prepareCloseAll (US3)", () => {
  it("allows the window to close when nothing is dirty", async () => {
    const harness = createHarness();

    await expect(harness.manager.prepareCloseAll()).resolves.toBe(true);
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(harness.files.writes).toHaveLength(0);
  });

  it.each(completingSequences().map((entry) => [entry] as const))(
    "completes the window close for Save/Don't Save sequence %j",
    async (decisions) => {
      const harness = createDirtyHarness();
      harness.dialogs.choices = [...decisions];

      await expect(harness.manager.prepareCloseAll()).resolves.toBe(true);

      // No Tab is removed and no replacement Untitled is created.
      expect(harness.manager.listSessions().map((s) => s.id)).toEqual(
        harness.ids,
      );
      expect(harness.dialogs.unsavedPromptCount).toBe(3);

      for (const [index, decision] of decisions.entries()) {
        const session = harness.manager.getSession(harness.ids[index])!;
        expect(session.dirty).toBe(decision === "dontSave");
      }

      const expectedWrites = decisions.filter(
        (decision) => decision === "save",
      ).length;
      expect(harness.files.writes).toHaveLength(expectedWrites);
    },
  );

  it.each(abortingSequences().map((entry) => [entry] as const))(
    "aborts the window close for %j",
    async ({ prefix, position, outcome }) => {
      const harness = createDirtyHarness();
      const saveCountBeforeAbort = prefix.filter(
        (decision) => decision === "save",
      ).length;
      if (outcome === "failure") {
        harness.files.failWriteIndexes.add(saveCountBeforeAbort + 1);
      }

      harness.dialogs.choices = [
        ...prefix,
        outcome === "cancel" ? "cancel" : "save",
      ];

      await expect(harness.manager.prepareCloseAll()).resolves.toBe(false);

      // Nothing is removed and no replacement Untitled appears.
      expect(harness.manager.listSessions().map((s) => s.id)).toEqual(
        harness.ids,
      );
      // Prompting stops exactly at the aborting document.
      expect(harness.dialogs.unsavedPromptCount).toBe(position + 1);

      for (const [index, decision] of prefix.entries()) {
        const session = harness.manager.getSession(harness.ids[index])!;
        // Earlier Save decisions stay committed; Don't Save leaves it dirty.
        expect(session.dirty).toBe(decision === "dontSave");
      }

      expect(harness.manager.getSession(harness.ids[position])!.dirty).toBe(
        true,
      );
      for (let index = position + 1; index < 3; index += 1) {
        expect(harness.manager.getSession(harness.ids[index])!.dirty).toBe(true);
      }
    },
  );

  it("reports a failed save during window close", async () => {
    const harness = createDirtyHarness();
    harness.files.failWriteIndexes.add(1);
    harness.dialogs.choices = ["save", "cancel"];

    await expect(harness.manager.prepareCloseAll()).resolves.toBe(false);

    expect(harness.dialogs.errors).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-cutting stress                                                       */
/* -------------------------------------------------------------------------- */

describe("DocumentManager 20-session stress", () => {
  it("keeps 20 documents isolated, ordered and uncapped", () => {
    const harness = createHarness();
    const ids: DocumentId[] = [harness.manager.getActiveSession().id];
    for (let index = 1; index < 20; index += 1) {
      ids.push(harness.manager.createUntitled());
    }

    // No artificial maximum is imposed.
    expect(harness.manager.listSessions()).toHaveLength(20);
    expect(tabNames(harness.manager.getSnapshot())).toEqual(
      Array.from({ length: 20 }, (_, index) => `Untitled${index + 1}`),
    );

    // Every document gets distinct content while it is the active one.
    for (const [index, id] of ids.entries()) {
      harness.manager.activateDocument(id);
      harness.editor.type(`content ${index}`);
    }

    // No document received another document's text or dirty state.
    for (const [index, id] of ids.entries()) {
      const session = harness.manager.getSession(id)!;
      expect(session.editorState.doc.toString()).toBe(`content ${index}`);
      expect(session.dirty).toBe(true);
      expect(session.savedBaseline.toString()).toBe("");
    }

    // Activation only changed the active id; Tab order is untouched.
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(ids[19]);
    expect(harness.manager.listSessions().map((s) => s.id)).toEqual(ids);

    harness.manager.activateDocument(ids[7]);
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(ids[7]);
    expect(harness.manager.listSessions().map((s) => s.id)).toEqual(ids);
    expect(harness.manager.hasDirtyDocuments()).toBe(true);
  });

  it("closes a mid-list document in a 20-session session without disturbing the rest", async () => {
    const harness = createHarness();
    const ids: DocumentId[] = [harness.manager.getActiveSession().id];
    for (let index = 1; index < 20; index += 1) {
      ids.push(harness.manager.createUntitled());
    }

    const target = ids[10];
    harness.manager.activateDocument(target);
    await expect(harness.manager.closeDocument(target)).resolves.toEqual({
      status: "closed",
    });

    expect(harness.manager.listSessions()).toHaveLength(19);
    expect(harness.manager.getSession(target)).toBeUndefined();
    // The left neighbour becomes active.
    expect(harness.manager.getSnapshot().activeDocumentId).toBe(ids[9]);
    expect(
      harness.manager.listSessions().map((session) => session.id),
    ).toEqual(ids.filter((id) => id !== target));
  });
});
