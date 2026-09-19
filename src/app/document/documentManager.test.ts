import { describe, expect, it } from "vitest";
import { EditorState, Text, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";

import type { EditorHandle, StateUpdateListener } from "../../editor/editorHandle";
import type {
  DocumentPathInspection,
  FileCommandError,
  FileService,
  OpenTextFileResult,
  ResolvedPathIdentity,
  WriteTextFileRequest,
} from "../../services/fileService";
import type {
  ExternalConflictChoice,
  FileDialogService,
  UnsavedChoice,
} from "../../services/fileDialogs";
import { DiskValidator } from "./diskValidation";
import type { DiskValidationResult, DiskValidationTrigger } from "./diskValidation";
import { DocumentManager } from "./documentManager";
import type { WatchInterestChange } from "./documentManager";
import { InternalFsOperationGuard } from "./internalFsOperationGuard";
import type { CapturedWatchHint } from "./internalFsOperationGuard";
import {
  NEW_DOCUMENT_FORMAT,
  type DocumentId,
  type DocumentManagerSnapshot,
  type DocumentSession,
  type DocumentViewState,
  type TabSnapshot,
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
  /** States installed by an external disk reload (005). */
  readonly reloadedStates: EditorState[] = [];
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

  /**
   * Models the reload path (005).
   *
   * The real bridge installs a whole new `EditorState` and scrolls the clamped
   * primary head into view; a state swap reports no document change, which is why
   * a reload can never be mistaken for a user edit.
   */
  reloadDocumentState(documentId: DocumentId, state: EditorState): void {
    this.boundDocumentId = documentId;
    this.state = state;
    this.reloadedStates.push(state);
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

  /** Models a user edit in the bound document, which CodeMirror reports as `docChanged`. */  type(text: string): void {
    // A real edit is a transaction against the live state, which is what keeps
    // history (and therefore a meaningful undo depth) around.
    const current = this.requireBoundState();
    const next = current.update({
      changes: { from: 0, to: current.doc.length, insert: text },
    }).state;
    this.deliver(next, true);
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
  /** Paths the 005 validation inspection was asked about. */
  readonly validationInspections: string[] = [];

  /** Registered existing files and directories, keyed by comparison key. */
  private readonly files = new Map<string, OpenTextFileResult | FileCommandError>();
  private readonly directories = new Set<string>();
  /** Alternative spellings that must resolve to another path's identity. */
  private readonly aliases = new Map<string, string>();
  /** Forced 005 validation outcomes, keyed by comparison key. */
  private readonly pathStates = new Map<string, DocumentPathInspection>();
  /** Per-inspection outcomes consumed in order, keyed by comparison key. */
  private readonly pathStateQueue = new Map<string, DocumentPathInspection[]>();
  /** Reported modification times, so a metadata-only touch is expressible. */
  private readonly modifiedTimes = new Map<string, number>();

  /**
   * Makes the *post-write* re-inspection of a path report another object's
   * comparison key.
   *
   * It models a destination whose canonical identity turned out to belong to a
   * different live session while the write was in flight, which is the case
   * FR-102 requires not to advance the saved baseline.
   */
  readonly adoptAsKey = new Map<string, string>();

  /** 1-based write indices that must fail, to place a save failure precisely. */
  readonly failWriteIndexes = new Set<number>();
  writeCallCount = 0;
  /** Invoked for every accepted write, so a test can inject watcher hints. */
  onWrite: ((request: WriteTextFileRequest) => void) | null = null;

  /**
   * Invoked at the create-if-absent boundary.
   *
   * Returning an error models another program creating the target in the window
   * between Sorakada's final absence check and its write, which is exactly the
   * race the atomic create path exists to close (T059).
   */
  onCreateConflict: ((request: WriteTextFileRequest) => FileCommandError | null) | null =
    null;

  /**
   * Invoked at the head of every content read.
   *
   * It models an outside write landing between an inspection that already
   * happened and the read that follows it, which is the window the post-write
   * proof has to survive (T060).
   */
  onRead: ((path: string) => void) | null = null;

  /** Every create-if-absent attempt, so a test can tell the two writers apart. */
  readonly creates: WriteTextFileRequest[] = [];

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

  /**
   * 006 object identity of each registered path.
   *
   * A real filesystem hands out a token that follows the *object*, so the fake
   * models it the same way: registering a path assigns a fresh token, an
   * in-place modification keeps it, and a remove/recreate cycle produces a
   * different one. That is what lets a rename be proven and a delete/recreate
   * replacement be refused without any test reaching for `as any`.
   */
  private readonly objectIdentities = new Map<string, string>();
  /**
   * Paths whose object identity the platform cannot supply.
   *
   * Modelling this explicitly is what lets a test pin the `null` fallback: an
   * unsupported filesystem must make 006 refuse continuity, never guess it.
   */
  private readonly unknownObjectIdentities = new Set<string>();
  private objectEpoch = 0;

  private nextObjectIdentity(key: string): string {
    this.objectEpoch += 1;
    return `fake:${key}#${this.objectEpoch}`;
  }

  /** Registers an object token for `key` unless it already has one. */
  private ensureObjectIdentity(key: string): string {
    const existing = this.objectIdentities.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const identity = this.nextObjectIdentity(key);
    this.objectIdentities.set(key, identity);
    return identity;
  }

  /** The token a path reports, or `null` when the platform cannot supply one. */
  private objectIdentityOrNull(key: string): string | null {
    if (this.unknownObjectIdentities.has(key)) {
      return null;
    }
    return this.ensureObjectIdentity(key);
  }

  /** The 006 object token of a path that currently exists. */
  objectIdentityFor(path: string): string {
    return this.ensureObjectIdentity(this.keyFor(path));
  }

  /** Forces a specific object token, modelling an externally replaced object. */
  setObjectIdentity(path: string, identity: string): void {
    this.objectIdentities.set(this.keyFor(path), identity);
  }

  /** Models a filesystem/platform that cannot identify this object at all. */
  clearObjectIdentity(path: string): void {
    const key = this.keyFor(path);
    this.objectIdentities.delete(key);
    this.unknownObjectIdentities.add(key);
  }

  /* -------- fixtures -------- */

  addFile(path: string, text = "", format: TextFormat = DEFAULT_FORMAT): void {
    const key = this.keyFor(path);
    this.files.set(key, {
      text,
      format: { ...format },
    });
    this.ensureObjectIdentity(key);
  }

  addUnreadableFile(path: string, error: FileCommandError): void {
    this.files.set(this.keyFor(path), error);
  }

  addDirectory(path: string): void {
    this.directories.add(this.keyFor(path));
  }

  /** Removes a registered file, modelling a rename/delete that moved it away. */
  removeFile(path: string): void {
    const key = this.keyFor(path);
    this.files.delete(key);
    // The object is gone, so its token must not be reusable by whatever appears
    // at the same path later.
    this.objectIdentities.delete(key);
  }

  /** The text currently registered for a path, or `undefined` when it is absent. */
  textFor(path: string): string | undefined {
    const entry = this.files.get(this.keyFor(path));
    return entry !== undefined && !("code" in entry) ? entry.text : undefined;
  }

  /** Rewrites a registered file, modelling an external modification. */
  updateFile(
    path: string,
    text: string,
    format: TextFormat = DEFAULT_FORMAT,
  ): void {
    const key = this.keyFor(path);
    this.files.set(key, {
      text,
      format: { ...format },
    });
    // Same object, new content: the token deliberately survives the rewrite.
    this.ensureObjectIdentity(key);
  }

  /** Forces the 005 validation outcome of one path. */
  setPathState(
    path: string,
    inspection: Omit<DocumentPathInspection, "requestedPath">,
  ): void {
    this.pathStates.set(this.keyFor(path), {
      ...inspection,
      requestedPath: path,
    });
  }

  /**
   * Queues one forced outcome per upcoming validation inspection of `path`.
   *
   * This is how a test models the disk changing *between* two inspections — a
   * target that reappears while a missing file is being recreated, for instance —
   * without depending on real timing.
   */
  queuePathState(
    path: string,
    inspection: Omit<DocumentPathInspection, "requestedPath">,
  ): void {
    const key = this.keyFor(path);
    const queue = this.pathStateQueue.get(key) ?? [];
    queue.push({ ...inspection, requestedPath: path });
    this.pathStateQueue.set(key, queue);
  }

  /**
   * Bumps a registered file's reported modification time without changing its
   * bytes: a metadata-only touch, which must never be a content conflict.
   */
  touchFile(path: string): void {
    const key = this.keyFor(path);
    this.modifiedTimes.set(key, (this.modifiedTimes.get(key) ?? 0) + 1);
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

    const requestedKey = this.keyFor(path);
    // The Save As pre-check resolves with `allowMissing`, the post-write
    // re-inspection does not, so only the latter is remapped.
    const key = allowMissing
      ? requestedKey
      : (this.adoptAsKey.get(requestedKey) ?? requestedKey);

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

  /**
   * The 005 validation inspection.
   *
   * It never rejects, and it separates `missing` from `unreadable`, which is what
   * FR-015 depends on. A path is a directory when it is registered as one *or*
   * when it is an ancestor of a registered path, because an existing file's parent
   * must not look missing in the harness.
   */
  inspectDocumentPath(path: string): Promise<DocumentPathInspection> {
    this.validationInspections.push(path);
    const key = this.keyFor(path);

    const queued = this.pathStateQueue.get(key);
    if (queued !== undefined && queued.length > 0) {
      return Promise.resolve({ ...queued.shift()!, requestedPath: path });
    }

    const forced = this.pathStates.get(key);
    if (forced !== undefined) {
      return Promise.resolve({ ...forced, requestedPath: path });
    }

    if (this.isKnownDirectory(key)) {
      return Promise.resolve({
        requestedPath: path,
        canonicalPath: path,
        comparisonKey: key,
        state: "directory",
        diskRevision: { size: 0, modifiedTimeMillis: 0 },
        message: null,
      });
    }

    const entry = this.files.get(key);
    if (entry !== undefined) {
      if ("code" in entry) {
        // A registered-but-unreadable file: the object exists, so this must never
        // be reported as missing.
        return Promise.resolve({
          requestedPath: path,
          canonicalPath: null,
          comparisonKey: key,
          state: "unreadable",
          diskRevision: null,
          message: entry.message,
        });
      }

      return Promise.resolve({
        requestedPath: path,
        canonicalPath: path,
        // The post-write proof reads the destination's identity through this
        // inspection, so a modelled "this destination belongs to another session"
        // remap has to apply here as well (see `adoptAsKey`).
        comparisonKey: this.adoptAsKey.get(key) ?? key,
        state: "file",
        diskRevision: {
          size: entry.text.length,
          modifiedTimeMillis: this.modifiedTimes.get(key) ?? 0,
        },
        message: null,
      });
    }

    return Promise.resolve({
      requestedPath: path,
      canonicalPath: null,
      comparisonKey: null,
      state: "missing",
      diskRevision: null,
      message: null,
    });
  }

  private isKnownDirectory(key: string): boolean {
    if (this.directories.has(key)) {
      return true;
    }
    for (const registered of [...this.files.keys(), ...this.directories.keys()]) {
      if (registered.startsWith(`${key}/`)) {
        return true;
      }
    }
    return false;
  }

  readTextFile(path: string): Promise<OpenTextFileResult> {
    this.reads.push(path);
    this.onRead?.(path);

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

  /**
   * The atomic recreate write (T059).
   *
   * It refuses a target that already exists, which is what makes a recreate
   * race-free: the disk state at this boundary decides, and the caller routes an
   * `already_exists` failure into the reappearance rules instead of overwriting.
   */
  createTextFileIfAbsent(request: WriteTextFileRequest): Promise<void> {
    this.creates.push(request);
    const conflict = this.onCreateConflict?.(request) ?? null;
    if (conflict !== null) {
      return Promise.reject(conflict);
    }

    const key = this.keyFor(request.path);
    if (this.files.has(key) || this.directories.has(key)) {
      return Promise.reject({
        code: "already_exists",
        message: `${request.path} already exists.`,
      } satisfies FileCommandError);
    }

    return this.writeTextFile(request);
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

    // A successful write is what makes the destination hold the written text, so a
    // later inspection must see it — otherwise the post-write revision
    // confirmation (SC-006) and every following validation would describe a file
    // that does not exist in this fake.
    this.files.set(this.keyFor(request.path), {
      text: request.text,
      format: {
        encoding: "utf8",
        bom: request.bom,
        detectedLineEnding:
          request.lineEnding === "crlf" ? "crlf" : "lf",
        preferredLineEnding: request.lineEnding,
      },
    });

    if (!this.holdWrites) {
      this.onWrite?.(request);
      return Promise.resolve();
    }

    this.onWrite?.(request);
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

  /**
   * Models a filesystem that compares paths case-sensitively.
   *
   * The canonical key is produced by the backend's own rule, so the frontend has
   * to work from *this* answer rather than folding case on its own (T155).
   */
  caseSensitiveKeys = false;

  private keyFor(path: string): string {
    const source = this.aliases.get(path) ?? path;
    const normalized = source
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/\.\//g, "/");
    return this.caseSensitiveKeys ? normalized : normalized.toLowerCase();
  }

  private identityFor(
    path: string,
    comparisonKey: string,
    kind: ResolvedPathIdentity["kind"],
  ): ResolvedPathIdentity {
    const entry = this.files.get(comparisonKey);
    const size =
      kind === "file" && entry !== undefined && !("code" in entry)
        ? entry.text.length
        : 0;

    return {
      requestedPath: path,
      canonicalPath: path,
      comparisonKey,
      kind,
      // The revision mirrors the fake's own contents, so "unchanged" really means
      // unchanged and a rewrite (or a touch) shows up as a changed revision (005).
      diskRevision:
        kind === "missing"
          ? null
          : {
              size,
              modifiedTimeMillis: this.modifiedTimes.get(comparisonKey) ?? 0,
            },
      // 006: only an object that exists carries a token, and a platform that
      // cannot supply one reports `null` instead of inventing continuity.
      objectIdentity:
        kind === "missing" ? null : this.objectIdentityOrNull(comparisonKey),
    };
  }
}

class FakeDialogs implements FileDialogService {
  openPath: string | null = null;
  savePath: string | null = null;
  unsavedChoice: UnsavedChoice = "cancel";
  /** 005: the answer to the explicit overwrite decision. */
  externalConflictChoice: ExternalConflictChoice = "cancel";
  /** 005: the answer to the discard-before-reload confirmation. */
  discardConfirmed = false;

  /** Per-prompt answers consumed in order; once empty `unsavedChoice` applies. */
  choices: UnsavedChoice[] = [];
  /** Per-request Save As targets consumed in order; once empty `savePath` applies. */
  savePaths: string[] = [];

  readonly errors: string[] = [];
  unsavedPromptCount = 0;
  readonly unsavedPrompts: string[] = [];
  /** 005: documents the overwrite decision was requested for. */
  readonly overwritePrompts: string[] = [];
  /** 005: documents the discard-before-reload decision was requested for. */
  readonly discardPrompts: string[] = [];

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

  confirmExternalOverwrite(
    displayName: string,
  ): Promise<ExternalConflictChoice> {
    this.overwritePrompts.push(displayName);
    return Promise.resolve(this.externalConflictChoice);
  }

  confirmDiscardForReload(displayName: string): Promise<boolean> {
    this.discardPrompts.push(displayName);
    return Promise.resolve(this.discardConfirmed);
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
  /** 005 validator wired to the same fake filesystem. */
  validator: DiskValidator;
  /** 005 shared internal-operation guard. */
  guard: InternalFsOperationGuard;
  snapshots: DocumentManagerSnapshot[];
  emissions(): number;
}

/** The active session, asserting the harness really has one. */
function activeSession(manager: DocumentManager): DocumentSession {
  const session = manager.getActiveSession();
  if (session === null) {
    throw new Error("Expected an active document.");
  }
  return session;
}

/** The active document id, asserting the harness really has one. */
function activeId(manager: DocumentManager): DocumentId {
  return activeSession(manager).id;
}

/**
 * A harness with one clean `Untitled1`.
 *
 * 003 makes "one document at launch" explicit rather than automatic, so the
 * harness performs the New the user would; `createBareHarness` covers the
 * zero-document state itself.
 */
function createHarness(): Harness {
  return createHarnessWithDocument(true);
}

/** A harness with no document at all, which is what a bare launch gives. */
function createBareHarness(): Harness {
  return createHarnessWithDocument(false);
}

function createHarnessWithDocument(openInitialDocument: boolean): Harness {
  const editor = new FakeEditor();
  const files = new FakeFileService();
  const dialogs = new FakeDialogs();
  const validator = new DiskValidator({ fileService: files });
  const guard = new InternalFsOperationGuard();
  const manager = new DocumentManager({
    editor,
    fileService: files,
    dialogs,
    diskValidator: validator,
    internalFsOperations: guard,
  });

  const snapshots: DocumentManagerSnapshot[] = [];

  if (openInitialDocument) {
    // Created before subscribing so the harness observes only the changes a
    // test makes, exactly as the 002 constructor did.
    manager.createUntitled();
  }

  manager.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });

  // Mirrors the application wiring: the `Editor` component mounts the initial
  // document into the shared view, then the bridge reports every state update
  // with the document id currently bound.
  const initial = manager.getActiveSession();
  if (initial !== null) {
    editor.setState(initial.id, initial.editorState);
  }
  editor.setStateUpdateListener((documentId, state, docChanged) => {
    manager.handleEditorStateUpdate(documentId, state, docChanged);
  });

  return {
    manager,
    editor,
    files,
    dialogs,
    validator,
    guard,
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
    expect(activeId(manager)).toBe(snapshot.tabs[0].id);
    expect(manager.getSession(snapshot.tabs[0].id)?.displayName).toBe(
      "Untitled1",
    );
  });

  it("appends and activates new untitled documents without disturbing earlier ones", () => {
    const { manager } = createHarness();
    const first = activeId(manager);

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
    const first = activeId(manager);
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
      activeId(manager),
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
    const first = activeId(manager);
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
    const id = activeId(manager);

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
    const id = activeId(manager);

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
    const id = activeId(manager);
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
    const active = activeId(manager);
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
    const first = activeId(manager);
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
    const first = activeId(manager);
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
    const first = activeId(manager);
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
    const first = activeId(manager);
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
    const active = activeId(manager);
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

    const first = activeId(manager);
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
    expect(activeSession(harness.manager).dirty).toBe(true);

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
      // 005 adds exactly one field: the external disk state FR-041 requires the
      // Tab strip to show. Nothing about the document itself may leak here.
      expect(Object.keys(tab).sort()).toEqual([
        "active",
        "dirty",
        "displayName",
        "externalState",
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
    const id = activeId(harness.manager);
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
    const id = activeId(harness.manager);
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
    const idA = activeId(harness.manager);
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
    const id = activeId(harness.manager);
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
    const idA = activeId(harness.manager);
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
    const idA = activeId(harness.manager);
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
    const keep = activeId(harness.manager);
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
    const id = activeId(harness.manager);
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
    const id = activeId(harness.manager);
    harness.editor.type("dirty");
    harness.dialogs.unsavedChoice = "dontSave";

    await expect(harness.manager.closeDocument(id)).resolves.toEqual({
      status: "closed",
    });

    expect(harness.manager.getSession(id)).toBeUndefined();
    expect(harness.files.writes).toHaveLength(0);
    // SR-001: the final Tab is not replaced by a fresh Untitled document.
    expect(tabNames(harness.manager.getSnapshot())).toEqual([]);
    expect(harness.manager.getSnapshot().activeDocumentId).toBeNull();
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
    const id = activeId(harness.manager);
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
    const first = activeId(harness.manager);
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
    const first = activeId(harness.manager);
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
    const first = activeId(harness.manager);
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
    const first = activeId(harness.manager);
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

  it("leaves zero documents when the final Tab closes", async () => {
    const harness = createHarness();
    const only = activeId(harness.manager);

    await expect(harness.manager.closeDocument(only)).resolves.toEqual({
      status: "closed",
    });

    expect(tabNames(harness.manager.getSnapshot())).toEqual([]);
    expect(harness.manager.getSession(only)).toBeUndefined();
    expect(harness.manager.getActiveSession()).toBeNull();
    expect(harness.manager.getSnapshot().activeDocumentId).toBeNull();

    // The Untitled counter still only ever increases (no number reuse).
    const fresh = harness.manager.createUntitled();
    expect(harness.manager.getSession(fresh)!.displayName).toBe("Untitled2");
  });

  it("never reuses an Untitled number after Save As and close", async () => {
    const harness = createHarness();
    const first = activeId(harness.manager);
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
  const ids: DocumentId[] = [activeId(harness.manager)];
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
    const ids: DocumentId[] = [activeId(harness.manager)];
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
    const ids: DocumentId[] = [activeId(harness.manager)];
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

/* -------------------------------------------------------------------------- */
/* US4 — zero-document lifecycle (FR-012..FR-018, SR-001, SR-002)              */
/* -------------------------------------------------------------------------- */

describe("DocumentManager zero-document lifecycle (US4)", () => {
  it("starts with no document, no session and no editor binding", () => {
    const harness = createBareHarness();

    expect(harness.manager.getSnapshot()).toEqual({
      activeDocumentId: null,
      tabs: [],
    });
    expect(harness.manager.listSessions()).toEqual([]);
    expect(harness.manager.getActiveSession()).toBeNull();
    expect(harness.manager.getActiveDocumentId()).toBeNull();
    expect(harness.manager.hasDirtyDocuments()).toBe(false);
    // A bare launch must not install a synthetic document in the shared view.
    expect(harness.editor.setStateCalls).toHaveLength(0);
    expect(harness.editor.boundDocumentId).toBeNull();
    expect(harness.emissions()).toBe(0);
  });

  it("creates exactly one active Untitled document when New is explicit", () => {
    const harness = createBareHarness();
    const id = harness.manager.createUntitled();

    expect(harness.manager.getSnapshot().activeDocumentId).toBe(id);
    expect(tabNames(harness.manager.getSnapshot())).toEqual(["Untitled1"]);
    expect(harness.manager.getSession(id)!.path).toBeNull();
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
    // The zero -> one transition is what binds the shared view.
    expect(harness.editor.boundDocumentId).toBe(id);
  });

  it("uses a nullable active identity without inventing a fake session", () => {
    const harness = createBareHarness();

    // Commands address a nullable active identity rather than a placeholder.
    expect(harness.manager.getActiveDocumentId()).toBeNull();

    harness.manager.activateDocument("doc-does-not-exist");
    expect(harness.manager.getActiveDocumentId()).toBeNull();
    expect(harness.manager.listSessions()).toHaveLength(0);

    // An update for a document that is not open is still ignored.
    harness.manager.handleEditorStateUpdate(
      "doc-not-open",
      EditorState.create({ doc: toText("orphan") }),
      true,
    );
    expect(harness.manager.listSessions()).toHaveLength(0);
    expect(harness.emissions()).toBe(0);
  });

  it("returns to zero documents after the final clean Tab closes", async () => {
    const harness = createHarness();
    const only = activeId(harness.manager);

    await expect(harness.manager.closeDocument(only)).resolves.toEqual({
      status: "closed",
    });

    expect(harness.manager.getSnapshot()).toEqual({
      activeDocumentId: null,
      tabs: [],
    });
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(harness.manager.getActiveSession()).toBeNull();
  });

  it("creates no replacement document from zero and still numbers forward", () => {
    const harness = createBareHarness();

    const first = harness.manager.createUntitled();
    harness.manager.createUntitled();
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "Untitled2",
    ]);

    harness.manager.closeDocument(first);
    expect(tabNames(harness.manager.getSnapshot())).toEqual(["Untitled2"]);

    // Numbers are never reused, even after zero documents have existed.
    const fresh = harness.manager.createUntitled();
    expect(harness.manager.getSession(fresh)!.displayName).toBe("Untitled3");
  });

  it("keeps the shared view untouched when the last document closes", async () => {
    const harness = createHarness();
    const only = activeId(harness.manager);

    await harness.manager.closeDocument(only);

    // A one -> zero transition detaches from the application's point of view;
    // the manager itself never installs a new state.
    const setStatesAfterClose = harness.editor.setStateCalls.length;
    expect(harness.manager.getSession(only)).toBeUndefined();
    expect(setStatesAfterClose).toBe(harness.editor.setStateCalls.length);
    expect(harness.manager.getSnapshot().activeDocumentId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* US3 — 003 path-ownership repairs (FR-099, FR-100, FR-102)                   */
/* -------------------------------------------------------------------------- */

const DRAFT_TARGET = "C:\\work\\draft.txt";

describe("DocumentManager destination ownership (003)", () => {
  it("refuses a Save As to a destination an Open is already resolving", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.files.holdReads = true;

    const opening = harness.manager.openPath(SMALL_A);
    await flush();

    const idB = harness.manager.createUntitled();
    harness.editor.type("draft B");
    harness.dialogs.savePath = SMALL_A;

    await expect(harness.manager.saveDocumentAs(idB)).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "path_resolution" }),
    });

    // The reservation is respected before anything is written.
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.manager.getSession(idB)!.path).toBeNull();
    expect(harness.manager.getSession(idB)!.dirty).toBe(true);

    harness.files.releaseReads();
    await expect(opening).resolves.toEqual(
      expect.objectContaining({ status: "opened" }),
    );
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "Untitled2",
      "a.txt",
    ]);
  });

  it("waits for an in-flight Save As instead of registering a duplicate session", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_B, "original");
    const idA = await openSmallA(harness);
    harness.editor.type("edited A");
    const readsBefore = harness.files.reads.length;

    harness.files.holdWrites = true;
    harness.dialogs.savePath = SMALL_B;
    const saving = harness.manager.saveDocumentAs(idA);
    await flush();
    expect(harness.files.pendingWriteCount()).toBe(1);

    const opening = harness.manager.openPath(SMALL_B);
    await flush();
    // The Open is blocked on the reservation rather than reading the file and
    // registering a second owner for the same canonical destination.
    expect(harness.files.reads).toHaveLength(readsBefore);

    harness.files.releaseWrites();
    await saving;

    await expect(opening).resolves.toEqual({
      status: "activated-existing",
      documentId: idA,
    });
    expect(harness.manager.listSessions()).toHaveLength(2);
    expect(harness.manager.getSession(idA)!.path).toBe(SMALL_B);
  });

  it("does not advance the baseline when a Save As cannot adopt its destination", async () => {
    const harness = createHarness();
    const idB = await openSmallA(harness);
    const idA = harness.manager.createUntitled();
    harness.editor.type("draft A");

    harness.dialogs.savePath = DRAFT_TARGET;
    // The destination turns out to resolve to a path another session already
    // owns, so this Save As must not claim it.
    harness.files.adoptAsKey.set(
      harness.files.comparisonKeyFor(DRAFT_TARGET),
      harness.files.comparisonKeyFor(SMALL_A),
    );

    await expect(harness.manager.saveDocumentAs(idA)).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "path_resolution" }),
    });

    // The bytes were written because the user asked for them, but the document
    // may not be reported clean or moved onto an unowned destination.
    expect(harness.files.writes).toHaveLength(1);
    const sessionA = harness.manager.getSession(idA)!;
    expect(sessionA.path).toBeNull();
    expect(sessionA.displayName).toBe("Untitled2");
    expect(sessionA.dirty).toBe(true);
    expect(sessionA.savedBaseline.toString()).toBe("");
    expect(harness.dialogs.errors).toHaveLength(1);

    // The existing owner is untouched.
    const sessionB = harness.manager.getSession(idB)!;
    expect(sessionB.path).toBe(SMALL_A);
    expect(sessionB.displayName).toBe("a.txt");
  });

  it("keeps one live owner per canonical destination across an Open/Save As race", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.files.addFile(SMALL_B, "bravo");
    const idA = await openSmallA(harness);

    // Both documents want the same destination; only one may end up owning it.
    harness.dialogs.savePath = SMALL_B;
    harness.manager.createUntitled();
    harness.editor.type("draft");
    const idDraft = activeId(harness.manager);

    const owner = await harness.manager.saveDocumentAs(idA);
    harness.dialogs.savePath = SMALL_B;
    const rival = await harness.manager.saveDocumentAs(idDraft);

    expect(owner.status).toBe("success");
    expect(rival.status).toBe("failed");

    const owners = harness.manager
      .listSessions()
      .filter(
        (session) =>
          session.pathIdentity?.comparisonKey ===
          harness.files.comparisonKeyFor(SMALL_B),
      );
    expect(owners).toHaveLength(1);
    expect(owners[0].id).toBe(idA);
    expect(harness.manager.getSession(idDraft)!.path).toBeNull();
    expect(harness.manager.getSession(idDraft)!.dirty).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* US3 — 003 close/exit save re-check (FR-101)                                 */
/* -------------------------------------------------------------------------- */

describe("DocumentManager close save re-check (003)", () => {
  it("saves edits that arrived during a close-triggered save instead of discarding them", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("first edit");
    harness.dialogs.unsavedChoice = "save";
    harness.files.holdWrites = true;

    const closing = harness.manager.closeDocument(id);
    await flush();

    // The user keeps typing while the save is in flight.
    harness.editor.type("first edit plus more");
    harness.files.holdWrites = false;
    harness.files.releaseWrites();

    await expect(closing).resolves.toEqual({ status: "closed" });

    // The guard asked again rather than discarding the newer edits, and the
    // second write carried them.
    expect(harness.dialogs.unsavedPromptCount).toBe(2);
    expect(harness.files.writes.map((write) => write.text)).toEqual([
      "first edit",
      "first edit plus more",
    ]);
    expect(harness.manager.getSession(id)).toBeUndefined();
  });

  it("keeps the Tab open when the user cancels the repeated close prompt", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("first edit");
    harness.dialogs.choices = ["save", "cancel"];
    harness.files.holdWrites = true;

    const closing = harness.manager.closeDocument(id);
    await flush();

    harness.editor.type("first edit plus more");
    harness.files.holdWrites = false;
    harness.files.releaseWrites();

    await expect(closing).resolves.toEqual({ status: "cancelled" });

    const session = harness.manager.getSession(id)!;
    expect(session.dirty).toBe(true);
    expect(session.editorState.doc.toString()).toBe("first edit plus more");
    expect(session.savedBaseline.toString()).toBe("first edit");
  });

  it("aborts the window close when an edit arrives during an exit-triggered save", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("first edit");
    harness.dialogs.choices = ["save", "cancel"];
    harness.files.holdWrites = true;

    const closing = harness.manager.prepareCloseAll();
    await flush();

    harness.editor.type("first edit plus more");
    harness.files.holdWrites = false;
    harness.files.releaseWrites();

    await expect(closing).resolves.toBe(false);

    // The exit decision had to be asked again, and the document is intact.
    expect(harness.dialogs.unsavedPromptCount).toBe(2);
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
    expect(harness.manager.getSession(id)!.editorState.doc.toString()).toBe(
      "first edit plus more",
    );
  });

  it("completes the window close when the repeated save captures the newer edits", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("first edit");
    harness.dialogs.unsavedChoice = "save";
    harness.files.holdWrites = true;

    const closing = harness.manager.prepareCloseAll();
    await flush();

    harness.editor.type("first edit plus more");
    harness.files.holdWrites = false;
    harness.files.releaseWrites();

    await expect(closing).resolves.toBe(true);
    expect(harness.dialogs.unsavedPromptCount).toBe(2);
    expect(harness.files.writes.map((write) => write.text)).toEqual([
      "first edit",
      "first edit plus more",
    ]);
    // Exit never removes Tabs; the window is destroyed instead.
    expect(harness.manager.getSession(id)).toBeDefined();
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* US6/US7 — path-mutation coordination (FR-103) and commit APIs               */
/* -------------------------------------------------------------------------- */

/** Resolves a fixture identity the way the application does. */
async function identityOf(
  harness: Harness,
  path: string,
  allowMissing = false,
): Promise<ResolvedPathIdentity> {
  return harness.files.inspectFilePath(path, allowMissing);
}

/** A synthetic identity for a path the fake service does not register. */
function syntheticIdentity(
  harness: Harness,
  path: string,
  kind: ResolvedPathIdentity["kind"] = "file",
): ResolvedPathIdentity {
  return {
    requestedPath: path,
    canonicalPath: path,
    comparisonKey: harness.files.comparisonKeyFor(path),
    kind,
    diskRevision: kind === "missing" ? null : { size: 0, modifiedTimeMillis: 0 },
    objectIdentity: kind === "missing" ? null : harness.files.objectIdentityFor(path),
  };
}

describe("DocumentManager path-mutation reservation (003)", () => {
  it("refuses a destination another live session owns", async () => {
    const harness = createHarness();
    await openSmallA(harness);

    const result = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey: harness.files.comparisonKeyFor("C:\\work\\other.txt"),
      destinationKey: harness.files.comparisonKeyFor(SMALL_A),
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("path_resolution");
      expect(result.error.message).not.toBe("");
    }
  });

  it("refuses a destination another mutation already reserved", async () => {
    const harness = createHarness();
    const destination = "C:\\work\\taken.txt";

    const first = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey: harness.files.comparisonKeyFor("C:\\work\\one.txt"),
      destinationKey: harness.files.comparisonKeyFor(destination),
    });
    expect(first.status).toBe("reserved");

    const second = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey: harness.files.comparisonKeyFor("C:\\work\\two.txt"),
      destinationKey: harness.files.comparisonKeyFor(destination),
    });
    expect(second.status).toBe("failed");

    if (first.status === "reserved") {
      first.reservation.release();
    }

    // Once released, the destination is available again.
    const third = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey: harness.files.comparisonKeyFor("C:\\work\\two.txt"),
      destinationKey: harness.files.comparisonKeyFor(destination),
    });
    expect(third.status).toBe("reserved");
    if (third.status === "reserved") {
      third.reservation.release();
    }
  });

  it("waits for an in-flight write on the mutated source", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("edited");

    harness.files.holdWrites = true;
    const saving = harness.manager.saveDocument(id);
    await flush();
    expect(harness.files.pendingWriteCount()).toBe(1);

    let reserved = false;
    const reserving = harness.manager
      .reservePathMutation({
        kind: "delete",
        sourceKey: harness.files.comparisonKeyFor(SMALL_A),
      })
      .then((result) => {
        reserved = true;
        return result;
      });
    await flush();

    // The mutation must not commit while a save is still writing that path.
    expect(reserved).toBe(false);

    harness.files.releaseWrites();
    await saving;

    const result = await reserving;
    expect(result.status).toBe("reserved");
    expect(reserved).toBe(true);
    if (result.status === "reserved") {
      result.reservation.release();
    }
  });

  it("waits for a pending Open below a directory being mutated", async () => {    const harness = createHarness();
    const directory = "C:\\work\\src";
    harness.files.addDirectory(directory);
    harness.files.addFile("C:\\work\\src\\a.ts", "alpha");
    harness.files.holdReads = true;

    const opening = harness.manager.openPath("C:\\work\\src\\a.ts");
    await flush();
    expect(harness.files.pendingReadCount()).toBe(1);

    let settled = false;
    const reserving = harness.manager
      .reservePathMutation({
        kind: "delete",
        sourceKey: harness.files.comparisonKeyFor(directory),
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await flush();
    expect(settled).toBe(false);

    harness.files.releaseReads();
    await opening;

    const result = await reserving;
    expect(result.status).toBe("reserved");
    if (result.status === "reserved") {
      result.reservation.release();
    }
  });

  it("blocks an Open that targets a path a pending mutation is moving", async () => {    const harness = createHarness();
    const directory = "C:\\work\\src";
    harness.files.addDirectory(directory);
    harness.files.addFile("C:\\work\\src\\a.ts", "alpha");

    const sourceIdentity = await identityOf(harness, directory);
    const reservation = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey: sourceIdentity.comparisonKey,
    });
    expect(reservation.status).toBe("reserved");

    const opening = harness.manager.openPath("C:\\work\\src\\a.ts");
    await flush();
    // Waiting on the mutation rather than resolving the about-to-move path.
    expect(harness.files.reads).toHaveLength(0);

    // The rename commits and the old path is gone.
    harness.manager.commitRenamedPath({
      sourceIdentity: {
        canonicalPath: sourceIdentity.canonicalPath,
        comparisonKey: sourceIdentity.comparisonKey,
      },
      newPath: "C:\\work\\lib",
      newIdentity: syntheticIdentity(harness, "C:\\work\\lib", "directory"),
    });
    harness.files.removeFile("C:\\work\\src\\a.ts");
    harness.files.addFile("C:\\work\\lib\\a.ts", "alpha");

    if (reservation.status === "reserved") {
      reservation.reservation.release();
    }

    const opened = await opening;
    expect(opened.status).toBe("failed");
    // No session was registered for a path that no longer exists.
    expect(harness.manager.listSessions()).toHaveLength(1);
    expect(tabNames(harness.manager.getSnapshot())).toEqual(["Untitled1"]);
  });

  it("holds a same-path save while a reservation covers that path", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("edited");

    const reservation = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey: harness.files.comparisonKeyFor(SMALL_A),
    });
    expect(reservation.status).toBe("reserved");

    let settled = false;
    const saving = harness.manager.saveDocument(id).then((result) => {
      settled = true;
      return result;
    });
    await flush();

    // The write has not been issued: the document's path is being changed, so
    // writing to the old spelling would contradict the disk operation (FR-103).
    expect(settled).toBe(false);
    expect(harness.files.writes).toHaveLength(0);

    if (reservation.status === "reserved") {
      reservation.reservation.release();
    }

    await expect(saving).resolves.toEqual({ status: "success" });
    expect(harness.files.writes).toHaveLength(1);
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });
});

describe("DocumentManager commitRenamedPath (003)", () => {
  it("moves an open file's path without replacing its id, state or dirty flag", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("unsaved change");
    const before = harness.manager.getSession(id)!;
    const stateBefore = before.editorState;
    const sourceIdentity = await identityOf(harness, SMALL_A);

    const affected = harness.manager.commitRenamedPath({
      sourceIdentity: {
        canonicalPath: sourceIdentity.canonicalPath,
        comparisonKey: sourceIdentity.comparisonKey,
      },
      newPath: "C:\\work\\renamed.txt",
      newIdentity: syntheticIdentity(harness, "C:\\work\\renamed.txt"),
    });

    expect(affected).toEqual([id]);

    const after = harness.manager.getSession(id)!;
    // Same object, same identity: only path-related metadata moved.
    expect(after).toBe(before);
    expect(after.editorState).toBe(stateBefore);
    expect(after.savedBaseline.toString()).toBe("alpha");
    expect(after.dirty).toBe(true);
    expect(after.path).toBe("C:\\work\\renamed.txt");
    expect(after.displayName).toBe("renamed.txt");
    expect(harness.manager.getSnapshot().tabs[1].displayName).toBe(
      "renamed.txt",
    );

    // Ownership moved with the path: the old key is free, the new one is owned.
    expect(
      harness.manager.findSessionsUnder(sourceIdentity.comparisonKey),
    ).toHaveLength(0);
    expect(
      harness.manager.findSessionsUnder(after.pathIdentity!.comparisonKey),
    ).toEqual([after]);

    // The old path can be opened again as a fresh session.
    harness.files.addFile(SMALL_A, "alpha");
    const reopened = await harness.manager.openPath(SMALL_A);
    expect(reopened.status).toBe("opened");
  });

  it("updates every open document below a renamed directory without touching siblings", async () => {
    const harness = createHarness();
    const directory = "C:\\work\\src";
    harness.files.addDirectory(directory);
    harness.files.addFile("C:\\work\\src\\a.ts", "alpha");
    harness.files.addFile("C:\\work\\src\\nested\\b.ts", "beta");
    harness.files.addFile("C:\\work\\src-old\\c.ts", "charlie");

    const openedA = await harness.manager.openPath("C:\\work\\src\\a.ts");
    const openedB = await harness.manager.openPath("C:\\work\\src\\nested\\b.ts");
    const openedSibling = await harness.manager.openPath(
      "C:\\work\\src-old\\c.ts",
    );
    if (
      openedA.status !== "opened" ||
      openedB.status !== "opened" ||
      openedSibling.status !== "opened"
    ) {
      throw new Error("Fixtures must open.");
    }

    const sourceIdentity = await identityOf(harness, directory);
    const affected = harness.manager.commitRenamedPath({
      sourceIdentity: {
        canonicalPath: sourceIdentity.canonicalPath,
        comparisonKey: sourceIdentity.comparisonKey,
      },
      newPath: "C:\\work\\lib",
      newIdentity: syntheticIdentity(harness, "C:\\work\\lib", "directory"),
    });

    expect(affected).toHaveLength(2);
    expect(harness.manager.getSession(openedA.documentId)!.path).toBe(
      "C:\\work\\lib\\a.ts",
    );
    expect(harness.manager.getSession(openedB.documentId)!.path).toBe(
      "C:\\work\\lib\\nested\\b.ts",
    );
    // A component-aware check keeps a sibling with a shared prefix out of it.
    expect(harness.manager.getSession(openedSibling.documentId)!.path).toBe(
      "C:\\work\\src-old\\c.ts",
    );
    expect(harness.manager.listSessions()).toHaveLength(4);
  });

  it("leaves untouched documents and untouched keys alone", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const sourceIdentity = await identityOf(harness, SMALL_A);

    const affected = harness.manager.commitRenamedPath({
      sourceIdentity: {
        canonicalPath: sourceIdentity.canonicalPath,
        comparisonKey: sourceIdentity.comparisonKey,
      },
      newPath: "C:\\work\\renamed.txt",
      newIdentity: syntheticIdentity(harness, "C:\\work\\renamed.txt"),
    });

    expect(affected).toEqual([id]);
    expect(harness.manager.listSessions()).toHaveLength(2);
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });
});

describe("DocumentManager deleted-session APIs (003)", () => {
  it("finds open sessions under a canonical path without scanning disk", async () => {
    const harness = createHarness();
    const directory = "C:\\work\\src";
    harness.files.addDirectory(directory);
    harness.files.addFile("C:\\work\\src\\a.ts", "alpha");
    harness.files.addFile("C:\\work\\src\\nested\\b.ts", "beta");
    harness.files.addFile("C:\\work\\src-old\\c.ts", "charlie");

    await harness.manager.openPath("C:\\work\\src\\a.ts");
    await harness.manager.openPath("C:\\work\\src\\nested\\b.ts");
    await harness.manager.openPath("C:\\work\\src-old\\c.ts");

    const key = (await identityOf(harness, directory)).comparisonKey;
    const affected = harness.manager.findSessionsUnder(key);

    expect(affected.map((session) => session.displayName)).toEqual([
      "a.ts",
      "b.ts",
    ]);

    // A file target reports exactly its own session.
    const fileKey = (await identityOf(harness, "C:\\work\\src\\a.ts"))
      .comparisonKey;
    expect(
      harness.manager
        .findSessionsUnder(fileKey)
        .map((session) => session.displayName),
    ).toEqual(["a.ts"]);
  });

  it("ignores untitled documents because they have no disk path", () => {
    const harness = createHarness();
    harness.editor.type("dirty draft");

    expect(
      harness.manager.findSessionsUnder(harness.files.comparisonKeyFor("C:\\")),
    ).toEqual([]);
  });

  it("removes confirmed-deleted sessions without a second prompt", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("dirty, about to be trashed");

    const removed = harness.manager.removeDeletedSessions([id]);

    expect(removed).toEqual([id]);
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.manager.getSession(id)).toBeUndefined();
    expect(tabNames(harness.manager.getSnapshot())).toEqual(["Untitled1"]);
  });

  it("returns to zero documents when the deleted sessions were the only ones", async () => {
    const harness = createBareHarness();
    const id = harness.manager.createUntitled();
    harness.manager.handleEditorStateUpdate(
      id,
      EditorState.create({ doc: toText("dirty") }),
      true,
    );

    harness.manager.removeDeletedSessions([id]);

    expect(harness.manager.getSnapshot()).toEqual({
      activeDocumentId: null,
      tabs: [],
    });
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
  });

  it("ignores ids that are no longer open", () => {
    const harness = createHarness();

    expect(harness.manager.removeDeletedSessions(["doc-gone"])).toEqual([]);
    expect(harness.manager.listSessions()).toHaveLength(1);
  });
});


/* -------------------------------------------------------------------------- */
/* 005 — external change (US1: clean reload)                                  */
/* -------------------------------------------------------------------------- */

const EDITOR_FORMAT: TextFormat = {
  encoding: "utf8",
  bom: "utf8",
  detectedLineEnding: "crlf",
  preferredLineEnding: "crlf",
};

/**
 * Drives one validation the way the opened-document coordinator does.
 *
 * These are document-domain tests: they exercise the manager's transition API with
 * a real `DiskValidator` result instead of going through the watcher adapter. The
 * coordinator's own event plumbing (coalescing, subscriptions, races) is covered in
 * `openedDocumentWatchCoordinator.test.ts`.
 */
async function validateHarnessDocument(
  harness: Harness,
  id: DocumentId,
  trigger: DiskValidationTrigger = "watcher-hint",
): Promise<DiskValidationResult> {
  const binding = harness.manager.getBinding(id);
  if (binding === null) {
    throw new Error("Expected a bound document.");
  }
  const session = harness.manager.getSession(id);
  if (session === undefined) {
    throw new Error("Expected an open document.");
  }

  const result = await harness.validator.validate({
    binding,
    trigger,
    isCurrent: () => harness.manager.isBindingCurrent(binding),
  });

  switch (result.outcome) {
    case "stale":
      return result;
    case "missing":
      harness.manager.markExternalState(binding, "missing");
      return result;
    case "unverifiable":
      await harness.manager.markValidationError(binding, result.error);
      return result;
    case "unchanged":
      harness.manager.adoptVerifiedIdentity(binding, result.identity);
      return result;
    case "changed":
      if (result.content === null) {
        harness.manager.markExternalState(binding, "modified");
        return result;
      }
      harness.manager.applyValidatedDiskSnapshot(binding, {
        identity: result.identity,
        content: result.content,
      });
      return result;
  }
}

/** The single tab snapshot the harness's documents produce. */
function tabFor(harness: Harness, id: DocumentId): TabSnapshot {
  const tab = harness.manager.getSnapshot().tabs.find((entry) => entry.id === id);
  if (tab === undefined) {
    throw new Error(`Expected a tab for ${id}.`);
  }
  return tab;
}

describe("DocumentManager external change — clean reload (US1, T016)", () => {
  it("reloads a clean document in place and keeps it clean (FR-016, FR-017, SC-001)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const before = harness.manager.getSession(id)!;
    const stateBefore = before.editorState;

    harness.files.updateFile(SMALL_A, "alpha changed externally");
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("changed");
    const after = harness.manager.getSession(id)!;
    expect(after.id).toBe(id);
    expect(after.editorState).not.toBe(stateBefore);
    expect(after.editorState.doc.toString()).toBe("alpha changed externally");
    expect(after.savedBaseline.toString()).toBe("alpha changed externally");
    expect(after.dirty).toBe(false);
    expect(after.externalState).toBe("normal");
    // The adopted revision is what makes the *next* validation cheap and correct.
    expect(after.pathIdentity?.diskRevision?.size).toBe(
      "alpha changed externally".length,
    );
    // The active document is pushed into the shared view exactly once.
    expect(harness.editor.reloadedStates).toHaveLength(1);
    expect(harness.dialogs.errors).toHaveLength(0);
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
  });

  it("clears undo history by replacing the state (FR-018)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    harness.editor.type("alpha edited");
    await harness.manager.saveDocument(id);
    expect(undoDepth(harness.manager.getSession(id)!.editorState)).toBeGreaterThan(0);

    harness.files.updateFile(SMALL_A, "replaced on disk");
    await validateHarnessDocument(harness, id);

    expect(harness.manager.getSession(id)!.editorState.doc.toString()).toBe(
      "replaced on disk",
    );
    expect(undoDepth(harness.manager.getSession(id)!.editorState)).toBe(0);
  });

  it("reloads a background document without activating its tab (US1 scenario 4)", async () => {
    const harness = createHarness();
    const first = await openSmallA(harness);
    harness.files.addFile(SMALL_B, "bravo");
    const second = await harness.manager.openPath(SMALL_B);
    if (second.status !== "opened") {
      throw new Error("Expected b.txt to open.");
    }
    const reloadsBefore = harness.editor.reloadedStates.length;

    harness.files.updateFile(SMALL_A, "alpha changed externally");
    await validateHarnessDocument(harness, first);

    expect(harness.manager.getActiveDocumentId()).toBe(second.documentId);
    expect(harness.manager.getSession(first)!.editorState.doc.toString()).toBe(
      "alpha changed externally",
    );
    // A background document is reloaded in place; the shared view is untouched.
    expect(harness.editor.reloadedStates).toHaveLength(reloadsBefore);
    expect(undoDepth(harness.manager.getSession(first)!.editorState)).toBe(0);
  });

  it("adopts a changed disk format together with the new baseline (edge case)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);

    // A different length so the revision comparison escalates to a read, which is
    // what makes the format observable at all.
    harness.files.updateFile(SMALL_A, "alpha with a BOM", EDITOR_FORMAT);
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("changed");
    const session = harness.manager.getSession(id)!;
    expect(session.format.bom).toBe("utf8");
    expect(session.format.preferredLineEnding).toBe("crlf");
    expect(session.savedBaseline.toString()).toBe("alpha with a BOM");
  });

  it("treats a metadata-only touch as unchanged and keeps the buffer (edge case)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const stateBefore = harness.manager.getSession(id)!.editorState;

    // Same bytes, new modification time: the revision comparison escalates to a
    // read, and the read proves the supported text did not change.
    harness.files.touchFile(SMALL_A);
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("changed");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState).toBe(stateBefore);
    expect(session.savedBaseline.toString()).toBe("alpha");
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
    // The new revision was still adopted, so the next validation is cheap again.
    expect(session.pathIdentity?.diskRevision?.modifiedTimeMillis).toBe(1);
    expect(harness.editor.reloadedStates).toHaveLength(0);
  });

  it("never replaces the buffer when the path cannot be inspected (FR-015, FR-043)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const stateBefore = harness.manager.getSession(id)!.editorState;

    harness.files.addUnreadableFile(SMALL_A, {
      code: "io_read",
      message: "The file is locked by another program.",
    });
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("unverifiable");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState).toBe(stateBefore);
    expect(session.dirty).toBe(false);
    // A locked file is not a missing file.
    expect(session.externalState).toBe("normal");
    expect(harness.dialogs.errors).toEqual([
      "The file is locked by another program.",
    ]);
  });

  it("never replaces the buffer when the read fails (FR-020, FR-043)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const stateBefore = harness.manager.getSession(id)!.editorState;

    // The revision changed (so the validator has to read), and the read fails.
    harness.files.updateFile(SMALL_A, "alpha replaced by binary");
    harness.files.readError = {
      code: "unsupported_binary",
      message: "The file contains binary data.",
    };
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("unverifiable");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState).toBe(stateBefore);
    expect(session.savedBaseline.toString()).toBe("alpha");
    expect(harness.dialogs.errors).toEqual(["The file contains binary data."]);
    expect(harness.editor.reloadedStates).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 005 — dirty protection (US2)                                               */
/* -------------------------------------------------------------------------- */

describe("DocumentManager external change — dirty protection (US2, T026)", () => {
  it("keeps a dirty buffer and marks the document externally modified (FR-021, FR-022)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    const stateBefore = harness.manager.getSession(id)!.editorState;

    harness.files.updateFile(SMALL_A, "someone else wrote this");
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("changed");
    if (result.outcome !== "changed") {
      throw new Error("Expected a changed outcome.");
    }
    // T061: the snapshot comes back as comparison material — the manager, not the
    // validator, decides that this text really diverged from the baseline.
    expect(result.content?.text).toBe("someone else wrote this");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState).toBe(stateBefore);
    expect(session.dirty).toBe(true);
    expect(session.savedBaseline.toString()).toBe("alpha");
    expect(session.externalState).toBe("modified");
    // No auto-reload ever happens for a dirty document.
    expect(harness.editor.reloadedStates).toHaveLength(0);
    expect(tabFor(harness, id).externalState).toBe("modified");
  });

  it("treats a metadata-only touch on a dirty document as no divergence (T061, edge case)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.addDirectory("C:\\work");
    const bindingBefore = harness.manager.getBinding(id)!;
    const baselineBefore = harness.manager.getSession(id)!.savedBaseline.toString();
    const stateBefore = harness.manager.getSession(id)!.editorState;

    // The revision moved but the supported text and format are exactly what this
    // document already holds as its baseline: a touch, not a divergence.
    harness.files.touchFile(SMALL_A);
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("changed");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState).toBe(stateBefore);
    expect(session.dirty).toBe(true);
    expect(session.savedBaseline.toString()).toBe(baselineBefore);
    // No false conflict: the document is still dirty and external `normal`.
    expect(session.externalState).toBe("normal");
    expect(tabFor(harness, id).externalState).toBe("normal");
    expect(harness.editor.reloadedStates).toHaveLength(0);
    // Only the revision advanced, so the next validation is cheap again.
    expect(session.pathIdentity?.diskRevision?.modifiedTimeMillis).toBe(1);
    expect(harness.manager.isBindingCurrent(bindingBefore)).toBe(true);

    // And Save proceeds as an ordinary save, without an overwrite prompt.
    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });
    expect(harness.dialogs.overwritePrompts).toHaveLength(0);
    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0].text).toBe("my unsaved work");
  });

  it("treats a BOM-only external change on a dirty document as divergence (T061)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.addDirectory("C:\\work");

    // Identical normalized text, different byte-relevant format: a real disk
    // change, so it must not be waved through as a touch. The revision moves with
    // it (a BOM adds bytes), which is what makes the validator read.
    harness.files.updateFile(SMALL_A, "alpha", {
      ...NEW_DOCUMENT_FORMAT,
      bom: "utf8",
    });
    harness.files.touchFile(SMALL_A);
    await validateHarnessDocument(harness, id);

    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("my unsaved work");
    expect(session.dirty).toBe(true);
    expect(session.externalState).toBe("modified");

    harness.dialogs.externalConflictChoice = "cancel";
    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "cancelled",
    });
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.dialogs.overwritePrompts).toEqual(["a.txt"]);
  });

  it("does not repeatedly disrupt a dirty document when hints keep arriving (FR-041, SC-004)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.updateFile(SMALL_A, "someone else wrote this");

    await validateHarnessDocument(harness, id);
    const stateAfterFirst = harness.manager.getSession(id)!.editorState;
    const snapshotsAfterFirst = harness.emissions();

    await validateHarnessDocument(harness, id);
    await validateHarnessDocument(harness, id);

    const session = harness.manager.getSession(id)!;
    expect(session.editorState).toBe(stateAfterFirst);
    expect(session.externalState).toBe("modified");
    expect(session.dirty).toBe(true);
    // A repeated hint that changes nothing must not emit another projection.
    expect(harness.emissions()).toBe(snapshotsAfterFirst);
    expect(harness.dialogs.errors).toHaveLength(0);
  });
});

describe("DocumentManager external change — save protection (US2, T027, T028)", () => {
  it("blocks ordinary Save until an explicit Overwrite and writes nothing on Cancel (FR-013, FR-023, FR-024, SC-002)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");

    // A change the realtime watcher never reported: only the mandatory pre-save
    // validation can find it.
    harness.files.updateFile(SMALL_A, "someone else wrote this");
    harness.dialogs.externalConflictChoice = "cancel";

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "cancelled",
    });

    expect(harness.files.writes).toHaveLength(0);
    const session = harness.manager.getSession(id)!;
    expect(session.dirty).toBe(true);
    expect(session.editorState.doc.toString()).toBe("my unsaved work");
    expect(session.savedBaseline.toString()).toBe("alpha");
    expect(session.externalState).toBe("modified");
    expect(harness.dialogs.overwritePrompts).toEqual(["a.txt"]);
    // The conflict is visible without another modal dialog.
    expect(tabFor(harness, id).externalState).toBe("modified");
  });

  it("writes the in-memory content and clears the conflict on Overwrite (FR-025)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.updateFile(SMALL_A, "someone else wrote this");
    harness.dialogs.externalConflictChoice = "overwrite";

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0].text).toBe("my unsaved work");
    expect(harness.files.writes[0].path).toBe(SMALL_A);
    const session = harness.manager.getSession(id)!;
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
    expect(session.savedBaseline.toString()).toBe("my unsaved work");
    expect(tabFor(harness, id).externalState).toBe("normal");
    expect(harness.dialogs.errors).toHaveLength(0);
  });

  it("advances nothing when the overwrite write fails (FR-025, edge case)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    const stateBefore = harness.manager.getSession(id)!.editorState;
    harness.files.updateFile(SMALL_A, "someone else wrote this");
    harness.dialogs.externalConflictChoice = "overwrite";
    harness.files.writeError = { code: "io_write", message: "disk full" };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "failed",
      error: { code: "io_write", message: "disk full" },
    });

    const session = harness.manager.getSession(id)!;
    expect(session.editorState).toBe(stateBefore);
    expect(session.dirty).toBe(true);
    expect(session.savedBaseline.toString()).toBe("alpha");
    // The conflict stays recorded, because no successful write resolved it.
    expect(session.externalState).toBe("modified");
  });

  it("clears the conflict only for the successful current operation (edit during overwrite)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.updateFile(SMALL_A, "someone else wrote this");
    harness.dialogs.externalConflictChoice = "overwrite";
    harness.files.holdWrites = true;

    const saving = harness.manager.saveDocument(id);
    await flush();
    expect(harness.files.pendingWriteCount()).toBe(1);

    // An edit that arrives while the write is in flight is newer than the captured
    // snapshot, so it must stay dirty after the write commits.
    harness.editor.type("my unsaved work plus more");
    harness.files.releaseWrites();
    await expect(saving).resolves.toEqual({ status: "success" });

    const session = harness.manager.getSession(id)!;
    expect(session.savedBaseline.toString()).toBe("my unsaved work");
    expect(session.dirty).toBe(true);
    // The disk now holds exactly the baseline, so there is no divergence left.
    expect(session.externalState).toBe("normal");
  });

  it("passes a dirty unchanged document straight through the existing save path (FR-013)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.dialogs.overwritePrompts).toHaveLength(0);
    expect(harness.manager.getSession(id)!.dirty).toBe(false);
  });

  it("requires an explicit discard confirmation before Reload from Disk replaces a dirty buffer (FR-027, T033)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.updateFile(SMALL_A, "disk version");

    harness.dialogs.discardConfirmed = false;
    await expect(harness.manager.reloadDocumentFromDisk(id)).resolves.toEqual({
      status: "cancelled",
    });
    expect(harness.manager.getSession(id)!.editorState.doc.toString()).toBe(
      "my unsaved work",
    );
    expect(harness.dialogs.discardPrompts).toEqual(["a.txt"]);

    harness.dialogs.discardConfirmed = true;
    await expect(harness.manager.reloadDocumentFromDisk(id)).resolves.toEqual({
      status: "success",
    });
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("disk version");
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
  });

  it("reloads a clean document from disk without any confirmation", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.updateFile(SMALL_A, "disk version");

    await expect(harness.manager.reloadDocumentFromDisk(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.dialogs.discardPrompts).toHaveLength(0);
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(harness.manager.getSession(id)!.editorState.doc.toString()).toBe(
      "disk version",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 005 — external delete (US3)                                                */
/* -------------------------------------------------------------------------- */

describe("DocumentManager external change — external delete (US3, T034-T036)", () => {
  it("keeps a clean document open as missing with its content intact (FR-028, FR-029, SC-003)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const stateBefore = harness.manager.getSession(id)!.editorState;
    const pathBefore = harness.manager.getSession(id)!.path;

    harness.files.removeFile(SMALL_A);
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("missing");
    const session = harness.manager.getSession(id)!;
    expect(session.id).toBe(id);
    expect(session.path).toBe(pathBefore);
    expect(session.editorState).toBe(stateBefore);
    expect(session.editorState.doc.toString()).toBe("alpha");
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("missing");
    expect(tabFor(harness, id).externalState).toBe("missing");
    // The 003 internal-Delete pathway must not run for an external delete.
    expect(harness.manager.listSessions()).toHaveLength(2);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "a.txt",
    ]);
  });

  it("keeps a dirty document's content and dirty state when it goes missing (FR-029)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");

    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);

    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("my unsaved work");
    expect(session.dirty).toBe(true);
    expect(session.externalState).toBe("missing");
    expect(harness.manager.listSessions()).toHaveLength(2);
  });

  it("recreates a clean missing file at its original path on Save (FR-030, FR-032)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);
    expect(harness.manager.getSession(id)!.externalState).toBe("missing");

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0]).toMatchObject({
      path: SMALL_A,
      text: "alpha",
    });
    const session = harness.manager.getSession(id)!;
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
    expect(session.savedBaseline.toString()).toBe("alpha");
  });

  it("recreates a dirty missing file and clears dirty only after the write (FR-030, FR-032)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");
    harness.editor.type("my unsaved work");
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0].text).toBe("my unsaved work");
    const session = harness.manager.getSession(id)!;
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
  });

  it("fails without creating ancestors when the parent directory is gone (FR-031)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.removeFile(SMALL_A);
    harness.files.setPathState("C:\\work", {
      canonicalPath: null,
      comparisonKey: null,
      state: "missing",
      diskRevision: null,
      message: null,
    });

    const result = await harness.manager.saveDocument(id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("path_resolution");
      expect(result.error.message).toContain("C:\\work");
    }
    // No write, no invented directory, and the document is still recoverable.
    expect(harness.files.writes).toHaveLength(0);
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("alpha");
    expect(session.path).toBe(SMALL_A);
    expect(session.externalState).toBe("missing");
    expect(harness.manager.listSessions()).toHaveLength(2);
  });

  it("does not overwrite a target that reappeared before the recreate (FR-045)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");
    harness.files.removeFile(SMALL_A);

    // The absence is confirmed, and only then does the file come back.
    harness.files.queuePathState(SMALL_A, {
      canonicalPath: null,
      comparisonKey: null,
      state: "missing",
      diskRevision: null,
      message: null,
    });
    harness.files.updateFile(SMALL_A, "reappeared content");

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    // The reappeared file was adopted, not overwritten with the stale buffer.
    expect(harness.files.writes).toHaveLength(0);
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("reappeared content");
    expect(session.savedBaseline.toString()).toBe("reappeared content");
    expect(session.externalState).toBe("normal");
  });

  it("asks for an explicit decision when a dirty missing target reappeared (FR-045, FR-034)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");
    harness.editor.type("my unsaved work");
    harness.files.removeFile(SMALL_A);
    harness.files.queuePathState(SMALL_A, {
      canonicalPath: null,
      comparisonKey: null,
      state: "missing",
      diskRevision: null,
      message: null,
    });
    harness.files.updateFile(SMALL_A, "reappeared content");
    harness.dialogs.externalConflictChoice = "cancel";

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "cancelled",
    });

    expect(harness.files.writes).toHaveLength(0);
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("my unsaved work");
    expect(session.dirty).toBe(true);
    expect(session.externalState).toBe("modified");
    expect(harness.dialogs.overwritePrompts).toEqual(["a.txt"]);
  });

  it("reloads a clean missing document when the path reappears (FR-033)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);
    expect(harness.manager.getSession(id)!.externalState).toBe("missing");

    harness.files.updateFile(SMALL_A, "recreated by another program");
    const result = await validateHarnessDocument(harness, id);

    expect(result.outcome).toBe("changed");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("recreated by another program");
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
  });

  it("treats a reappeared path as divergence without reloading a dirty document (FR-034)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);

    harness.files.updateFile(SMALL_A, "recreated by another program");
    await validateHarnessDocument(harness, id);

    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("my unsaved work");
    expect(session.dirty).toBe(true);
    expect(session.externalState).toBe("modified");
    expect(harness.editor.reloadedStates).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 005 — watch interest and stale completions                                 */
/* -------------------------------------------------------------------------- */

describe("DocumentManager watch interest (T023, FR-001-FR-004)", () => {
  it("announces a bound interest on open and an unbound one on close", async () => {
    const harness = createHarness();
    const changes: WatchInterestChange[] = [];
    harness.manager.subscribeWatchInterest((change) => {
      changes.push(change);
    });

    const id = await openSmallA(harness);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "bound", documentId: id, path: SMALL_A });

    await harness.manager.closeDocument(id);
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ type: "unbound", documentId: id, path: SMALL_A });
  });

  it("never announces interest for an untitled document (FR-002)", () => {
    const harness = createHarness();
    const changes: WatchInterestChange[] = [];
    harness.manager.subscribeWatchInterest((change) => {
      changes.push(change);
    });

    harness.manager.createUntitled();

    expect(changes).toEqual([]);
  });

  it("announces the first bound interest when Save As binds an Untitled document (FR-002, FR-004)", async () => {
    const harness = createHarness();
    const id = harness.manager.createUntitled();
    harness.editor.type("brand new");
    const changes: WatchInterestChange[] = [];
    harness.manager.subscribeWatchInterest((change) => {
      changes.push(change);
    });
    harness.files.addDirectory("C:\\work");
    harness.dialogs.savePath = "C:\\work\\fresh.txt";

    await harness.manager.saveDocumentAs(id);

    // An Untitled document had no interest before, so this is its first binding —
    // not a migration — and the watcher consumer must start watching it.
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: "bound",
      documentId: id,
      path: "C:\\work\\fresh.txt",
    });
  });

  it("announces a rebound interest for every document an internal rename moves (FR-004)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const changes: WatchInterestChange[] = [];
    harness.manager.subscribeWatchInterest((change) => {
      changes.push(change);
    });
    const sourceIdentity = await identityOf(harness, SMALL_A);

    const affected = harness.manager.commitRenamedPath({
      sourceIdentity: {
        canonicalPath: sourceIdentity.canonicalPath,
        comparisonKey: sourceIdentity.comparisonKey,
      },
      newPath: "C:\\work\\renamed.txt",
      newIdentity: syntheticIdentity(harness, "C:\\work\\renamed.txt"),
    });

    expect(affected).toEqual([id]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: "rebound",
      documentId: id,
      previousPath: SMALL_A,
      path: "C:\\work\\renamed.txt",
    });
  });

  it("bumps the binding generation so an in-flight validation becomes stale", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const binding = harness.manager.getBinding(id)!;
    harness.files.addDirectory("C:\\work");
    harness.dialogs.savePath = "C:\\work\\elsewhere.txt";

    await harness.manager.saveDocumentAs(id);

    expect(harness.manager.isBindingCurrent(binding)).toBe(false);
    expect(harness.manager.markExternalState(binding, "missing")).toBe(false);
    expect(
      harness.manager.applyValidatedDiskSnapshot(binding, {
        identity: binding.identity,
        content: { text: "stale", format: { ...NEW_DOCUMENT_FORMAT } },
      }),
    ).toBe("stale");
    expect(harness.manager.getSession(id)!.editorState.doc.toString()).toBe(
      "alpha",
    );
  });

  it("rejects a result for a document that was closed while it was in flight", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const binding = harness.manager.getBinding(id)!;

    await harness.manager.closeDocument(id);

    expect(harness.manager.isBindingCurrent(binding)).toBe(false);
    expect(harness.manager.markExternalState(binding, "missing")).toBe(false);
    await expect(
      harness.manager.markValidationError(binding, {
        code: "io_read",
        message: "too late",
      }),
    ).resolves.toBe(false);
    expect(harness.dialogs.errors).toHaveLength(0);
  });

  it("reports a validation failure once per distinct message (FR-041, FR-043)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const binding = harness.manager.getBinding(id)!;

    await harness.manager.markValidationError(binding, {
      code: "io_read",
      message: "locked",
    });
    await harness.manager.markValidationError(binding, {
      code: "io_read",
      message: "locked",
    });
    expect(harness.dialogs.errors).toEqual(["locked"]);

    // A different failure is new information and must be shown.
    await harness.manager.markValidationError(binding, {
      code: "io_read",
      message: "still locked",
    });
    expect(harness.dialogs.errors).toEqual(["locked", "still locked"]);

    // A later successful validation clears the dedupe, so the next failure of the
    // same shape is reported again (retry on a later trigger).
    harness.files.touchFile(SMALL_A);
    await validateHarnessDocument(harness, id);
    await harness.manager.markValidationError(binding, {
      code: "io_read",
      message: "still locked",
    });
    expect(harness.dialogs.errors).toHaveLength(3);
  });

  it("surfaces the external state in the tab projection and requests no confirmation for a clean reload (T050)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");

    expect(tabFor(harness, id).externalState).toBe("normal");

    harness.files.updateFile(SMALL_A, "disk version");
    await validateHarnessDocument(harness, id);

    expect(tabFor(harness, id).externalState).toBe("normal");
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
    expect(harness.dialogs.overwritePrompts).toHaveLength(0);
    expect(harness.dialogs.discardPrompts).toHaveLength(0);
    expect(harness.dialogs.errors).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 005 — internal filesystem operation reconciliation (T045)                  */
/* -------------------------------------------------------------------------- */

describe("DocumentManager internal operation reconciliation (T045, FR-035, FR-036)", () => {
  it("reconciles the notifications an internal rename produces (SC-006)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });

    const newPath = "C:\\work\\renamed.txt";
    const sourceKey = harness.files.comparisonKeyFor(SMALL_A);
    const newKey = harness.files.comparisonKeyFor(newPath);
    const reservation = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey,
      destinationKey: newKey,
    });
    expect(reservation.status).toBe("reserved");

    // The watcher offers the notifications the disk rename is about to produce.
    expect(
      harness.guard.capture({
        comparisonKey: sourceKey,
        path: SMALL_A,
        kind: "removed",
      }),
    ).toBe(true);
    expect(
      harness.guard.capture({
        comparisonKey: newKey,
        path: newPath,
        kind: "created",
      }),
    ).toBe(true);

    harness.files.removeFile(SMALL_A);
    harness.files.addFile(newPath, "alpha");
    harness.manager.commitRenamedPath({
      sourceIdentity: {
        canonicalPath: SMALL_A,
        comparisonKey: sourceKey,
      },
      newPath,
      newIdentity: syntheticIdentity(harness, newPath),
    });
    if (reservation.status === "reserved") {
      reservation.reservation.release();
    }

    // Every notification the rename produced is explained by its post-operation
    // state, so nothing is reported and no document is marked as diverging.
    expect(reconciliations).toEqual([]);
    const session = harness.manager.getSession(id)!;
    expect(session.path).toBe(newPath);
    expect(session.externalState).toBe("normal");
    expect(session.dirty).toBe(false);
  });

  it("reconciles a successful internal delete without surfacing an external delete (FR-035)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness);
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });

    const key = harness.files.comparisonKeyFor(SMALL_A);
    const reservation = await harness.manager.reservePathMutation({
      kind: "delete",
      sourceKey: key,
    });
    expect(reservation.status).toBe("reserved");
    expect(
      harness.guard.capture({
        comparisonKey: key,
        path: SMALL_A,
        kind: "removed",
      }),
    ).toBe(true);

    harness.files.removeFile(SMALL_A);
    harness.manager.removeDeletedSessions([id]);
    if (reservation.status === "reserved") {
      reservation.reservation.release();
    }

    expect(reconciliations).toEqual([]);
    // 003 close semantics still ran, and no second unsaved-work prompt appeared.
    expect(harness.manager.listSessions()).toHaveLength(1);
    expect(harness.dialogs.unsavedPromptCount).toBe(0);
  });

  it("surfaces a notification the rename cannot explain (FR-036)", async () => {
    const harness = createHarness();
    await openSmallA(harness);
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });

    const newPath = "C:\\work\\renamed.txt";
    const sourceKey = harness.files.comparisonKeyFor(SMALL_A);
    const newKey = harness.files.comparisonKeyFor(newPath);
    const reservation = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey,
      destinationKey: newKey,
    });

    // The destination was created by the rename, so a removal of it cannot be
    // explained by the operation.
    harness.guard.capture({
      comparisonKey: newKey,
      path: newPath,
      kind: "removed",
    });

    harness.files.removeFile(SMALL_A);
    harness.manager.commitRenamedPath({
      sourceIdentity: { canonicalPath: SMALL_A, comparisonKey: sourceKey },
      newPath,
      newIdentity: syntheticIdentity(harness, newPath),
    });
    if (reservation.status === "reserved") {
      reservation.reservation.release();
    }

    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]).toEqual([
      { comparisonKey: newKey, path: newPath, kind: "removed" },
    ]);
  });

  it("surfaces every captured hint when a reserved mutation never commits (FR-036)", async () => {
    const harness = createHarness();
    await openSmallA(harness);
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });

    const key = harness.files.comparisonKeyFor(SMALL_A);
    const reservation = await harness.manager.reservePathMutation({
      kind: "delete",
      sourceKey: key,
    });
    expect(
      harness.guard.capture({
        comparisonKey: key,
        path: SMALL_A,
        kind: "changed",
      }),
    ).toBe(true);

    // The disk operation failed or was cancelled, so nothing may be declared
    // internal: the captured hint has to be validated as real divergence.
    if (reservation.status === "reserved") {
      reservation.reservation.release();
    }

    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0][0]).toMatchObject({
      comparisonKey: key,
      kind: "changed",
    });
  });

  it("does not swallow a save's own successful notification (SC-006)", async () => {    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });
    harness.editor.type("my unsaved work");

    // The write registers a hint for its own path, exactly as the real watcher
    // would while the write is in flight.
    harness.files.onWrite = (request) => {
      harness.guard.capture({
        comparisonKey: harness.files.comparisonKeyFor(request.path),
        path: request.path,
        kind: "changed",
      });
    };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    expect(reconciliations).toEqual([]);
    const session = harness.manager.getSession(id)!;
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
  });

  it("reconciles the notification an internal Save As produces for its new path (FR-035)", async () => {
    const harness = createHarness();
    const id = harness.manager.createUntitled();
    harness.editor.type("brand new");
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });
    harness.files.addDirectory("C:\\work");
    const target = "C:\\work\\fresh.txt";
    harness.dialogs.savePath = target;

    // The watcher reports the destination the Save As is about to create.
    harness.files.onWrite = (request) => {
      harness.guard.capture({
        comparisonKey: harness.files.comparisonKeyFor(request.path),
        path: request.path,
        kind: "created",
      });
    };

    await expect(harness.manager.saveDocumentAs(id)).resolves.toEqual({
      status: "success",
    });

    expect(reconciliations).toEqual([]);
    const session = harness.manager.getSession(id)!;
    expect(session.path).toBe(target);
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
  });

  it("does not let a discarded disk version hide a dirty conflict (FR-021, FR-023)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    const binding = harness.manager.getBinding(id)!;
    const adoptedRevision = binding.identity.diskRevision;

    // Disk content handed to a dirty document *without* a confirmed discard: the
    // buffer is kept, and the adopted revision must not advance, otherwise the
    // divergence would look resolved to every later validation and the next Save
    // could overwrite the external version without asking.
    const outcome = harness.manager.applyValidatedDiskSnapshot(binding, {
      identity: {
        ...binding.identity,
        diskRevision: { size: 999, modifiedTimeMillis: 999 },
      },
      content: {
        text: "someone else wrote this",
        format: { ...NEW_DOCUMENT_FORMAT },
      },
    });

    expect(outcome).toBe("external-modified");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("my unsaved work");
    expect(session.dirty).toBe(true);
    expect(session.externalState).toBe("modified");
    expect(session.pathIdentity?.diskRevision).toEqual(adoptedRevision);

    // The conflict survives the next validation, and Save still has to ask before
    // it may write anything.
    harness.files.updateFile(SMALL_A, "someone else wrote this");
    await validateHarnessDocument(harness, id);
    expect(harness.manager.getSession(id)!.externalState).toBe("modified");

    harness.dialogs.externalConflictChoice = "cancel";
    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "cancelled",
    });
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.dialogs.overwritePrompts).toEqual(["a.txt"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 005 — atomic recreate and a proven post-write state (T059, T060)            */
/* -------------------------------------------------------------------------- */

describe("DocumentManager atomic recreate (T059, FR-045)", () => {
  it("uses create-if-absent for the recreate branch and a plain write everywhere else", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");

    // An ordinary save only ever writes.
    harness.editor.type("my unsaved work");
    await harness.manager.saveDocument(id);
    expect(harness.files.creates).toHaveLength(0);
    expect(harness.files.writes).toHaveLength(1);

    // A recreate of a confirmed-missing target creates instead.
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);
    harness.editor.type("recreated content");
    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });
    expect(harness.files.creates).toHaveLength(1);
    expect(harness.files.creates[0]).toMatchObject({
      path: SMALL_A,
      text: "recreated content",
    });
  });

  it("never overwrites a target that appears at the create boundary (FR-045)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);
    expect(harness.manager.getSession(id)!.externalState).toBe("missing");

    // The target reappears in the window between the final absence check and the
    // create. The create is atomic, so Sorakada learns about it instead of
    // destroying the new file.
    harness.files.onCreateConflict = () => {
      harness.files.updateFile(SMALL_A, "written by another program");
      return {
        code: "already_exists",
        message: `${SMALL_A} already exists.`,
      };
    };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    // Nothing was overwritten: the plain writer never ran, and the clean document
    // adopted the file that had appeared.
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.files.textFor(SMALL_A)).toBe("written by another program");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("written by another program");
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
  });

  it("asks before replacing a target that appears at the create boundary for a dirty document (FR-045)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");
    harness.editor.type("my unsaved work");
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);

    harness.files.onCreateConflict = () => {
      harness.files.updateFile(SMALL_A, "written by another program");
      return {
        code: "already_exists",
        message: `${SMALL_A} already exists.`,
      };
    };
    harness.dialogs.externalConflictChoice = "cancel";

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "cancelled",
    });

    expect(harness.files.writes).toHaveLength(0);
    expect(harness.files.textFor(SMALL_A)).toBe("written by another program");
    const session = harness.manager.getSession(id)!;
    expect(session.editorState.doc.toString()).toBe("my unsaved work");
    expect(session.dirty).toBe(true);
    expect(session.externalState).toBe("modified");
    expect(harness.dialogs.overwritePrompts).toEqual(["a.txt"]);
  });

  it("writes only after the user explicitly overwrites the race winner (FR-045, FR-025)", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addDirectory("C:\\work");
    harness.editor.type("my unsaved work");
    harness.files.removeFile(SMALL_A);
    await validateHarnessDocument(harness, id);

    harness.files.onCreateConflict = () => {
      harness.files.updateFile(SMALL_A, "written by another program");
      return {
        code: "already_exists",
        message: `${SMALL_A} already exists.`,
      };
    };
    harness.dialogs.externalConflictChoice = "overwrite";

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    expect(harness.files.writes).toHaveLength(1);
    expect(harness.files.writes[0].text).toBe("my unsaved work");
    expect(harness.files.textFor(SMALL_A)).toBe("my unsaved work");
    const session = harness.manager.getSession(id)!;
    expect(session.dirty).toBe(false);
    expect(session.externalState).toBe("normal");
  });
});

describe("DocumentManager post-write proof (T060, FR-036)", () => {
  it("does not declare reconciliation when an outside write wins the read-back", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });
    harness.editor.type("my unsaved work");

    // The write lands, then another program replaces it before Sorakada can prove
    // what is on disk. The watcher hint for our own write arrives in that window.
    harness.files.onWrite = (request) => {
      harness.guard.capture({
        comparisonKey: harness.files.comparisonKeyFor(request.path),
        path: request.path,
        kind: "changed",
      });
      harness.files.updateFile(SMALL_A, "outside write won");
    };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    // The baseline advanced to what Sorakada actually wrote, but the disk no longer
    // matches it, so the document is externally modified rather than clean.
    const session = harness.manager.getSession(id)!;
    expect(session.savedBaseline.toString()).toBe("my unsaved work");
    expect(session.externalState).toBe("modified");
    expect(tabFor(harness, id).externalState).toBe("modified");
    // The adopted revision is unknown, so the next validation must read content
    // instead of trusting metadata.
    expect(session.pathIdentity?.diskRevision).toBeNull();
    // And the operation's own hint was surfaced for revalidation, not swallowed.
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0][0]).toMatchObject({
      comparisonKey: harness.files.comparisonKeyFor(SMALL_A),
      kind: "changed",
    });

    // A following validation converges on the outside content.
    await validateHarnessDocument(harness, id);
    const converged = harness.manager.getSession(id)!;
    expect(converged.editorState.doc.toString()).toBe("outside write won");
    expect(converged.externalState).toBe("normal");
  });

  it("detects an outside write that lands between the proof's inspection and its read", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");

    let landed = false;
    harness.files.onRead = () => {
      if (landed) {
        return;
      }
      landed = true;
      harness.files.updateFile(SMALL_A, "outside write during the proof");
    };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    const session = harness.manager.getSession(id)!;
    expect(session.savedBaseline.toString()).toBe("my unsaved work");
    expect(session.externalState).toBe("modified");
    expect(session.pathIdentity?.diskRevision).toBeNull();

    harness.files.onRead = null;
    await validateHarnessDocument(harness, id);
    expect(harness.manager.getSession(id)!.editorState.doc.toString()).toBe(
      "outside write during the proof",
    );
  });

  it("keeps the conflict state when the read-back cannot be completed", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });
    harness.files.onWrite = (request) => {
      harness.guard.capture({
        comparisonKey: harness.files.comparisonKeyFor(request.path),
        path: request.path,
        kind: "changed",
      });
    };
    // The read-back cannot be completed, so nothing may be claimed as reconciled.
    harness.files.readError = { code: "io_read", message: "locked" };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    const session = harness.manager.getSession(id)!;
    expect(session.savedBaseline.toString()).toBe("my unsaved work");
    // A failed proof is not a divergence: no conflict is invented, and the state
    // the document already had is preserved.
    expect(session.externalState).toBe("normal");
    expect(session.pathIdentity?.diskRevision).toBeNull();
    expect(reconciliations).toHaveLength(1);

    // Once reading works again the document converges without a false conflict.
    harness.files.readError = null;
    await validateHarnessDocument(harness, id);
    const converged = harness.manager.getSession(id)!;
    expect(converged.dirty).toBe(false);
    expect(converged.externalState).toBe("normal");
    expect(converged.editorState.doc.toString()).toBe("my unsaved work");
  });

  it("adopts a Save As destination but not its unproven content", async () => {
    const harness = createHarness();
    const id = harness.manager.createUntitled();
    harness.editor.type("brand new");
    const target = "C:\\work\\fresh.txt";
    harness.files.addDirectory("C:\\work");
    harness.dialogs.savePath = target;
    harness.files.onWrite = () => {
      harness.files.updateFile(target, "someone else got there first");
    };

    await expect(harness.manager.saveDocumentAs(id)).resolves.toEqual({
      status: "success",
    });

    // The path is adopted because the write really happened there, but the disk no
    // longer holds Sorakada's bytes, so the document is not reported clean.
    const session = harness.manager.getSession(id)!;
    expect(session.path).toBe(target);
    expect(session.savedBaseline.toString()).toBe("brand new");
    expect(session.externalState).toBe("modified");
    expect(session.pathIdentity?.diskRevision).toBeNull();
  });

  it("settles as reconciled only when the disk really holds the written snapshot", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });
    harness.editor.type("my unsaved work");
    harness.files.onWrite = (request) => {
      harness.guard.capture({
        comparisonKey: harness.files.comparisonKeyFor(request.path),
        path: request.path,
        kind: "changed",
      });
    };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    const session = harness.manager.getSession(id)!;
    expect(session.externalState).toBe("normal");
    expect(session.dirty).toBe(false);
    // The proof succeeded, so the write's own notification is reconciled and the
    // revision is a real one again.
    expect(reconciliations).toEqual([]);
    expect(session.pathIdentity?.diskRevision).not.toBeNull();
  });
});
describe("DocumentManager clean pre-save validation failure (T063, FR-043)", () => {
  it("surfaces a clean document's unverifiable pre-save failure instead of a silent success", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const before = harness.manager.getSession(id)!;
    const stateBefore = before.editorState;
    const baselineBefore = before.savedBaseline.toString();
    const formatBefore = { ...before.format };

    // The path cannot be verified at all (locked, denied, or a transient I/O
    // failure on a file that is not missing).
    harness.files.addUnreadableFile(SMALL_A, {
      code: "io_read",
      message: "locked by another program",
    });

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });

    // The failure reached the user through the existing non-destructive path...
    expect(harness.dialogs.errors).toEqual(["locked by another program"]);
    // ...and nothing at all about the document or the disk changed.
    const after = harness.manager.getSession(id)!;
    expect(after.editorState).toBe(stateBefore);
    expect(after.savedBaseline.toString()).toBe(baselineBefore);
    expect(after.format).toEqual(formatBefore);
    expect(after.dirty).toBe(false);
    expect(after.externalState).toBe("normal");
    expect(harness.files.writes).toHaveLength(0);
    expect(harness.files.creates).toHaveLength(0);
  });

  it("reports a repeated identical failure once, and a new failure again", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.files.addUnreadableFile(SMALL_A, {
      code: "io_read",
      message: "locked by another program",
    });

    await harness.manager.saveDocument(id);
    await harness.manager.saveDocument(id);

    // Repeated identical failures must not turn every Save into another dialog.
    expect(harness.dialogs.errors).toEqual(["locked by another program"]);

    // A different failure is new information and must be shown.
    harness.files.addUnreadableFile(SMALL_A, {
      code: "io_read",
      message: "still locked, now by something else",
    });
    await harness.manager.saveDocument(id);
    expect(harness.dialogs.errors).toEqual([
      "locked by another program",
      "still locked, now by something else",
    ]);
  });

  it("keeps blocking a dirty document while the clean case only reports", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    harness.editor.type("my unsaved work");
    harness.files.addUnreadableFile(SMALL_A, {
      code: "io_read",
      message: "locked by another program",
    });

    // A dirty document has data at risk, so the same failure is also a failed save.
    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "failed",
      error: { code: "io_read", message: "locked by another program" },
    });
    expect(harness.manager.getSession(id)!.dirty).toBe(true);
    expect(harness.files.writes).toHaveLength(0);
  });
});
/* -------------------------------------------------------------------------- */
/* 005 — post-proof notification ordering (T064)                              */
/* -------------------------------------------------------------------------- */

describe("DocumentManager settlement after the write proof (T064, FR-036)", () => {
  it("does not discard a same-path hint that arrives after the read-back proof", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });
    harness.editor.type("my unsaved work");
    const key = harness.files.comparisonKeyFor(SMALL_A);

    let reads = 0;
    harness.files.onRead = () => {
      reads += 1;
      if (reads === 1) {
        // Sorakada's own write notification arrives while the first proof reads
        // the file back, so that proof is already older than the notification.
        harness.guard.capture({ comparisonKey: key, path: SMALL_A, kind: "changed" });
        return;
      }
      if (reads === 2) {
        // The re-proof's read: an outside write lands now — after a proof had
        // succeeded and before the guard settles — together with its hint.
        harness.files.updateFile(SMALL_A, "outside write after the proof");
        harness.guard.capture({ comparisonKey: key, path: SMALL_A, kind: "changed" });
      }
    };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });
    harness.files.onRead = null;

    // The later proof sees the outside content, so the operation reconciles
    // nothing: the baseline is what Sorakada wrote, but the disk is not.
    const session = harness.manager.getSession(id)!;
    expect(session.savedBaseline.toString()).toBe("my unsaved work");
    expect(session.externalState).toBe("modified");
    expect(session.pathIdentity?.diskRevision).toBeNull();
    // The hint was surfaced for validation rather than discarded on the strength
    // of the earlier proof.
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]).toHaveLength(2);
    expect(reconciliations[0][0]).toMatchObject({ comparisonKey: key });

    // And the document converges on what is really there.
    await validateHarnessDocument(harness, id);
    const converged = harness.manager.getSession(id)!;
    expect(converged.editorState.doc.toString()).toBe("outside write after the proof");
    expect(converged.externalState).toBe("normal");
  });

  it("invents no conflict when the notifications keep arriving but the disk holds our bytes", async () => {
    const harness = createHarness();
    const id = await openSmallA(harness, "alpha");
    const reconciliations: CapturedWatchHint[][] = [];
    harness.manager.subscribeReconciliation((hints) => {
      reconciliations.push([...hints]);
    });
    harness.editor.type("my unsaved work");
    const key = harness.files.comparisonKeyFor(SMALL_A);

    // A pathological burst: a notification for this key during every read-back, so
    // no proof can ever be attributed to this operation.
    harness.files.onRead = () => {
      harness.guard.capture({ comparisonKey: key, path: SMALL_A, kind: "changed" });
    };

    await expect(harness.manager.saveDocument(id)).resolves.toEqual({
      status: "success",
    });
    harness.files.onRead = null;

    const session = harness.manager.getSession(id)!;
    expect(session.savedBaseline.toString()).toBe("my unsaved work");
    // The disk really does hold Sorakada's bytes, so no conflict is invented — the
    // operation only declined to claim the notifications as its own.
    expect(session.externalState).toBe("normal");
    expect(tabFor(harness, id).externalState).toBe("normal");
    expect(harness.dialogs.overwritePrompts).toHaveLength(0);
    expect(session.pathIdentity?.diskRevision).toBeNull();
    // Nothing was swallowed: the burst was handed to the consumer.
    expect(reconciliations.length).toBeGreaterThan(0);
    expect(harness.guard.pendingHintCount()).toBe(0);

    // A later validation confirms the baseline is intact, so the user never sees a
    // conflict for their own save.
    await validateHarnessDocument(harness, id);
    const converged = harness.manager.getSession(id)!;
    expect(converged.dirty).toBe(false);
    expect(converged.externalState).toBe("normal");
    expect(converged.editorState.doc.toString()).toBe("my unsaved work");
    expect(harness.dialogs.errors).toHaveLength(0);
  });

  it("re-proves a Save As settlement as well", async () => {
    const harness = createHarness();
    const id = harness.manager.createUntitled();
    harness.editor.type("brand new");
    const target = "C:\\work\\fresh.txt";
    harness.manager.subscribeReconciliation(() => undefined);
    harness.files.addDirectory("C:\\work");
    harness.dialogs.savePath = target;
    const key = harness.files.comparisonKeyFor(target);

    let reads = 0;
    harness.files.onRead = () => {
      reads += 1;
      if (reads === 1) {
        harness.guard.capture({ comparisonKey: key, path: target, kind: "created" });
        return;
      }
      if (reads === 2) {
        harness.files.updateFile(target, "someone else got there first");
        harness.guard.capture({ comparisonKey: key, path: target, kind: "created" });
      }
    };

    await expect(harness.manager.saveDocumentAs(id)).resolves.toEqual({
      status: "success",
    });
    harness.files.onRead = null;

    const session = harness.manager.getSession(id)!;
    expect(session.path).toBe(target);
    expect(session.savedBaseline.toString()).toBe("brand new");
    expect(session.externalState).toBe("modified");
    expect(session.pathIdentity?.diskRevision).toBeNull();
  });
});
/* -------------------------------------------------------------------------- */
/* External relocation adoption (006 US2)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Models an external rename on the fake filesystem: the source disappears, the
 * destination appears and both paths report the *same* filesystem-object token,
 * which is exactly the evidence 006 requires before continuity may be claimed.
 */
function moveFileExternally(
  files: FakeFileService,
  sourcePath: string,
  destinationPath: string,
  text: string,
): string {
  const identity = files.objectIdentityFor(sourcePath);
  files.removeFile(sourcePath);
  files.addFile(destinationPath, text);
  files.setObjectIdentity(destinationPath, identity);
  return identity;
}

describe("DocumentManager external relocation (006 US2)", () => {
  it("adopts a confirmed relocation without touching document state", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";
    const before = harness.manager.getSession(id)!;
    const editorState = before.editorState;
    const generation = before.bindingGeneration;
    const readsBefore = harness.files.reads.length;

    const entryIdentity = moveFileExternally(
      harness.files,
      SMALL_A,
      SMALL_B,
      "alpha",
    );

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: entryIdentity,
    });

    expect(outcomes).toEqual([
      { documentId: id, status: "adopted", path: SMALL_B },
    ]);

    const after = harness.manager.getSession(id)!;
    // FR-057: identity, text, editor state, history and dirty state all survive;
    // only path-facing metadata moves.
    expect(after.id).toBe(id);
    expect(after.editorState).toBe(editorState);
    expect(after.displayName).toBe("b.txt");
    expect(after.path).toBe(SMALL_B);
    expect(after.pathIdentity?.comparisonKey).toBe(
      harness.files.comparisonKeyFor(SMALL_B),
    );
    // FR-065: the binding generation advances, so an in-flight validation for the
    // old path is stale from now on.
    expect(after.bindingGeneration).toBe(generation + 1);
    // FR-035/FR-057: relocation never reads or replaces the buffer.
    expect(harness.files.reads).toHaveLength(readsBefore);
    // FR-035: the active Tab is not changed by an external structural change.
    expect(harness.manager.getActiveDocumentId()).toBe(id);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "b.txt",
    ]);
  });

  it("keeps a dirty document dirty and follows the new path", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";

    const edited = EditorState.create({ doc: toText("alpha edited") });
    harness.manager.handleEditorStateUpdate(id, edited, true);
    expect(harness.manager.getSession(id)!.dirty).toBe(true);

    const entryIdentity = moveFileExternally(
      harness.files,
      SMALL_A,
      SMALL_B,
      "alpha",
    );

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: entryIdentity,
    });

    expect(outcomes[0].status).toBe("adopted");
    const after = harness.manager.getSession(id)!;
    // FR-059: a dirty document is eligible to follow a confirmed move, and its
    // unsaved buffer is not reloaded.
    expect(after.dirty).toBe(true);
    expect(after.editorState).toBe(edited);
    expect(after.editorState.doc.toString()).toBe("alpha edited");
  });

  it("proves the destination from its own binding, never from the entry token", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";
    const targetIdentity = harness.files.objectIdentityFor(SMALL_A);

    moveFileExternally(harness.files, SMALL_A, SMALL_B, "alpha");

    // A moved symlink entry keeps its *own* token, which is a different identity
    // domain from the target the document is bound to. The request therefore
    // carries an entry token that differs from the binding's, and adoption must
    // still succeed because the destination proves the *target* (FR-067, plan §10).
    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: "obj:the-link-entry-itself",
    });

    expect(outcomes).toEqual([
      { documentId: id, status: "adopted", path: SMALL_B },
    ]);
    expect(harness.manager.getSession(id)!.pathIdentity?.objectIdentity).toBe(
      targetIdentity,
    );
  });

  it("moves path ownership exactly once", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";

    const entryIdentity = moveFileExternally(
      harness.files,
      SMALL_A,
      SMALL_B,
      "alpha",
    );

    const first = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: entryIdentity,
    });
    expect(first[0].status).toBe("adopted");

    // A second attempt for the same document no longer finds the old binding, so
    // it changes nothing instead of duplicating ownership.
    const second = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: entryIdentity,
    });
    expect(second).toEqual([]);
    expect(harness.manager.getSession(id)!.path).toBe(SMALL_B);
  });

  it("refuses a destination that is a different filesystem object", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";

    // The destination exists but is *not* the same object: rename continuity
    // must never be guessed from paths alone (FR-039, FR-041).
    harness.files.addFile(SMALL_B, "alpha");
    harness.files.removeFile(SMALL_A);

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: "obj:whatever-the-tree-saw",
    });

    expect(outcomes).toEqual([
      {
        documentId: id,
        status: "rejected",
        path: SMALL_A,
        reason: "identity-mismatch",
      },
    ]);
    expect(harness.manager.getSession(id)!.path).toBe(SMALL_A);
  });

  it("refuses when no object identity can prove continuity", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    // The platform cannot identify the source object, so the binding holds no
    // continuity evidence to compare anything against.
    harness.files.clearObjectIdentity(SMALL_A);
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";
    expect(harness.manager.getSession(id)!.pathIdentity?.objectIdentity).toBeNull();

    harness.files.removeFile(SMALL_A);
    harness.files.addFile(SMALL_B, "alpha");

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: null,
    });

    expect(outcomes[0].status).toBe("rejected");
    expect(outcomes[0].reason).toBe("identity-unavailable");
    expect(harness.manager.getSession(id)!.path).toBe(SMALL_A);
  });

  it("refuses a destination another live session already owns", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.files.addFile(SMALL_B, "beta");
    const first = await harness.manager.openPath(SMALL_A);
    const firstId = first.status === "opened" ? first.documentId : "";
    const second = await harness.manager.openPath(SMALL_B);
    const secondId = second.status === "opened" ? second.documentId : "";

    // Both paths report one object identity, so the destination is *provably*
    // the same object; ownership is still decided by the canonical path, which
    // another live session holds (FR-062, FR-063).
    const identity = harness.files.objectIdentityFor(SMALL_A);
    harness.files.setObjectIdentity(SMALL_B, identity);
    harness.files.removeFile(SMALL_A);

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: identity,
    });

    expect(outcomes).toEqual([
      {
        documentId: firstId,
        status: "rejected",
        path: SMALL_A,
        reason: "destination-owned",
      },
    ]);
    // Neither session was merged, moved or closed.
    expect(harness.manager.getSession(firstId)!.path).toBe(SMALL_A);
    expect(harness.manager.getSession(secondId)!.path).toBe(SMALL_B);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "a.txt",
      "b.txt",
    ]);
  });

  it("adopts a directory relocation and rebases each open descendant", async () => {
    const harness = createHarness();
    const SOURCE_DIR = "C:\\work\\src";
    const TARGET_DIR = "C:\\work\\lib";
    const FIRST = `${SOURCE_DIR}\\a.ts`;
    const SECOND = `${SOURCE_DIR}\\nested\\b.ts`;
    harness.files.addDirectory(SOURCE_DIR);
    harness.files.addFile(FIRST, "alpha");
    harness.files.addFile(SECOND, "beta");
    harness.files.addDirectory(`${SOURCE_DIR}\\nested`);

    const first = await harness.manager.openPath(FIRST);
    const second = await harness.manager.openPath(SECOND);
    const firstId = first.status === "opened" ? first.documentId : "";
    const secondId = second.status === "opened" ? second.documentId : "";
    const firstIdentity = harness.files.objectIdentityFor(FIRST);
    const secondIdentity = harness.files.objectIdentityFor(SECOND);

    // The whole directory moved: both descendants keep their own object.
    harness.files.removeFile(FIRST);
    harness.files.removeFile(SECOND);
    harness.files.addFile(`${TARGET_DIR}\\a.ts`, "alpha");
    harness.files.addFile(`${TARGET_DIR}\\nested\\b.ts`, "beta");
    harness.files.setObjectIdentity(`${TARGET_DIR}\\a.ts`, firstIdentity);
    harness.files.setObjectIdentity(`${TARGET_DIR}\\nested\\b.ts`, secondIdentity);

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SOURCE_DIR,
      newPath: TARGET_DIR,
      kind: "directory",
      entryObjectIdentity: "obj:src-directory",
    });

    expect(outcomes).toEqual([
      { documentId: firstId, status: "adopted", path: `${TARGET_DIR}\\a.ts` },
      {
        documentId: secondId,
        status: "adopted",
        path: `${TARGET_DIR}\\nested\\b.ts`,
      },
    ]);
    expect(harness.manager.getSession(firstId)!.path).toBe(`${TARGET_DIR}\\a.ts`);
    expect(harness.manager.getSession(secondId)!.path).toBe(
      `${TARGET_DIR}\\nested\\b.ts`,
    );
    expect(harness.manager.getSession(firstId)!.editorState.doc.toString()).toBe(
      "alpha",
    );
  });

  it("rejects one conflicting descendant without blocking its siblings", async () => {
    const harness = createHarness();
    const SOURCE_DIR = "C:\\work\\src";
    const TARGET_DIR = "C:\\work\\lib";
    const FIRST = `${SOURCE_DIR}\\a.ts`;
    const SECOND = `${SOURCE_DIR}\\b.ts`;
    harness.files.addDirectory(SOURCE_DIR);
    harness.files.addFile(FIRST, "alpha");
    harness.files.addFile(SECOND, "beta");

    const first = await harness.manager.openPath(FIRST);
    const second = await harness.manager.openPath(SECOND);
    const firstId = first.status === "opened" ? first.documentId : "";
    const secondId = second.status === "opened" ? second.documentId : "";

    const firstIdentity = harness.files.objectIdentityFor(FIRST);
    const secondIdentity = harness.files.objectIdentityFor(SECOND);

    harness.files.removeFile(FIRST);
    harness.files.removeFile(SECOND);
    harness.files.addFile(`${TARGET_DIR}\\a.ts`, "alpha");
    harness.files.setObjectIdentity(`${TARGET_DIR}\\a.ts`, firstIdentity);
    // The sibling's destination is now a *different* object.
    harness.files.addFile(`${TARGET_DIR}\\b.ts`, "beta");

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SOURCE_DIR,
      newPath: TARGET_DIR,
      kind: "directory",
      entryObjectIdentity: "obj:src-directory",
    });

    expect(outcomes).toEqual([
      { documentId: firstId, status: "adopted", path: `${TARGET_DIR}\\a.ts` },
      {
        documentId: secondId,
        status: "rejected",
        path: SECOND,
        reason: "identity-mismatch",
      },
    ]);
    // The rejected document keeps its own binding and stays subject to 005.
    expect(harness.manager.getSession(secondId)!.path).toBe(SECOND);
    expect(secondIdentity).not.toBe(firstIdentity);
  });

  it("never uses the object identity as the path-ownership key", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.files.addFile(SMALL_B, "alpha");
    // Two hard-link-like paths that share one filesystem object.
    const shared = harness.files.objectIdentityFor(SMALL_A);
    harness.files.setObjectIdentity(SMALL_B, shared);

    const first = await harness.manager.openPath(SMALL_A);
    const second = await harness.manager.openPath(SMALL_B);

    // FR-067: distinct canonical paths stay distinct sessions; a shared native
    // object id must not merge them.
    expect(first.status).toBe("opened");
    expect(second.status).toBe("opened");
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "a.txt",
      "b.txt",
    ]);
    const firstId = first.status === "opened" ? first.documentId : "";
    const secondId = second.status === "opened" ? second.documentId : "";
    expect(harness.manager.getSession(firstId)!.pathIdentity?.objectIdentity).toBe(
      shared,
    );
    expect(harness.manager.getSession(secondId)!.pathIdentity?.objectIdentity).toBe(
      shared,
    );

    // Destination reservation still keys on the canonical path, so a Save As
    // onto the sibling path is refused for the path, never for the token.
    const reservation = await harness.manager.reservePathMutation({
      kind: "rename",
      sourceKey: harness.files.comparisonKeyFor(SMALL_A),
      destinationKey: harness.files.comparisonKeyFor(SMALL_B),
    });
    expect(reservation.status).toBe("failed");
    reservation.status === "failed"
      ? expect(reservation.error.message).toContain("another tab")
      : undefined;
  });
});

  it("announces a relocation rebound even when only the path casing changed", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";

    const changes: WatchInterestChange[] = [];
    harness.manager.subscribeWatchInterest((change) => changes.push(change));

    // Windows: `a.txt` -> `A.TXT` keeps the canonical comparison key, so only the
    // *path* changed. 005 must still be told, because the forced post-relocation
    // validation hangs off that rebound (FR-046, FR-061).
    const CASED = "C:\\work\\A.TXT";
    const entryIdentity = moveFileExternally(
      harness.files,
      SMALL_A,
      CASED,
      "alpha",
    );

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: CASED,
      kind: "file",
      entryObjectIdentity: entryIdentity,
    });

    expect(outcomes).toEqual([
      { documentId: id, status: "adopted", path: CASED },
    ]);
    expect(changes).toHaveLength(1);
    const change = changes[0];
    expect(change.type).toBe("rebound");
    if (change.type !== "rebound") {
      throw new Error("expected a rebound");
    }
    expect(change.cause).toBe("external-relocation");
    expect(change.path).toBe(CASED);
    expect(change.previousPath).toBe(SMALL_A);
    expect(change.identity.comparisonKey).toBe(
      change.previousIdentity.comparisonKey,
    );
  });

  it("notifies the UI once after a successful adoption", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";
    expect(tabFor(harness, id).displayName).toBe("a.txt");

    const entryIdentity = moveFileExternally(
      harness.files,
      SMALL_A,
      SMALL_B,
      "alpha",
    );

    // The snapshot stream, not a direct read: the UI only learns about the new
    // name through an emission (FR-057).
    const emitted: DocumentManagerSnapshot[] = [];
    harness.manager.subscribe((snapshot) => emitted.push(snapshot));
    const emissionsBefore = harness.emissions();

    await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: entryIdentity,
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].tabs.find((tab) => tab.id === id)?.displayName).toBe(
      "b.txt",
    );
    expect(harness.emissions()).toBe(emissionsBefore + 1);
  });

  it("refuses a destination an in-flight Open is about to claim", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    harness.files.addFile(SMALL_B, "beta");
    const opened = await harness.manager.openPath(SMALL_A);
    const firstId = opened.status === "opened" ? opened.documentId : "";

    // The relocation destination is provably the same object as the open
    // document's binding (a hard-link-like case), but another Open of that very
    // path is still in flight.
    const identity = harness.files.objectIdentityFor(SMALL_A);
    harness.files.setObjectIdentity(SMALL_B, identity);
    harness.files.removeFile(SMALL_A);

    harness.files.holdReads = true;
    const pendingOpen = harness.manager.openPath(SMALL_B);
    // The Open inspects before it reads, so its read is only issued once that
    // inspection has settled.
    await flush();
    expect(harness.files.pendingReadCount()).toBe(1);

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: SMALL_A,
      newPath: SMALL_B,
      kind: "file",
      entryObjectIdentity: identity,
    });

    // Waiting could not change this: a successful Open registers itself as the
    // canonical owner of that key, so adopting first would leave two live
    // sessions claiming one path (FR-062, FR-063).
    expect(outcomes).toEqual([
      {
        documentId: firstId,
        status: "rejected",
        path: SMALL_A,
        reason: "destination-owned",
      },
    ]);
    expect(harness.manager.getSession(firstId)!.path).toBe(SMALL_A);

    // Once the Open settles, ownership is exactly one session per path: the new
    // session owns the destination and the old one keeps its own binding.
    harness.files.releaseReads();
    const openedByPending = await pendingOpen;
    expect(openedByPending.status).toBe("opened");
    const secondId =
      openedByPending.status === "opened" ? openedByPending.documentId : "";
    expect(secondId).not.toBe(firstId);
    expect(harness.manager.getSession(secondId)!.path).toBe(SMALL_B);
    expect(harness.manager.getSession(firstId)!.path).toBe(SMALL_A);
    expect(tabNames(harness.manager.getSnapshot())).toEqual([
      "Untitled1",
      "a.txt",
      "b.txt",
    ]);
  });

  it("follows a relocation whose logical spelling differs only by case", async () => {
    const harness = createHarness();
    // The session keeps the spelling it was opened with...
    const LOWER = "c:\\work\\a.txt";
    harness.files.addFile(LOWER, "alpha");
    const opened = await harness.manager.openPath(LOWER);
    const id = opened.status === "opened" ? opened.documentId : "";

    // ...while the Tree reports the on-disk spelling for the same entry.
    const DESTINATION = "C:\\WORK\\B.TXT";
    const identity = moveFileExternally(harness.files, LOWER, DESTINATION, "alpha");

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: "C:\\WORK\\A.TXT",
      newPath: DESTINATION,
      kind: "file",
      entryObjectIdentity: identity,
    });

    expect(outcomes).toEqual([
      { documentId: id, status: "adopted", path: DESTINATION },
    ]);
    expect(harness.manager.getSession(id)!.path).toBe(DESTINATION);
  });

  it("rebases a nested open document when the moved directory is spelled differently", async () => {
    const harness = createHarness();
    const SOURCE = "C:\\work\\src";
    const TARGET = "C:\\work\\lib";
    const NESTED = `${SOURCE}\\nested\\b.ts`;
    harness.files.addDirectory(SOURCE);
    harness.files.addDirectory(`${SOURCE}\\nested`);
    harness.files.addFile(NESTED, "beta");
    const opened = await harness.manager.openPath(NESTED);
    const id = opened.status === "opened" ? opened.documentId : "";

    const identity = harness.files.objectIdentityFor(NESTED);
    harness.files.removeFile(NESTED);
    harness.files.addFile(`${TARGET}\\nested\\b.ts`, "beta");
    harness.files.setObjectIdentity(`${TARGET}\\nested\\b.ts`, identity);

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: "C:\\WORK\\SRC",
      newPath: TARGET,
      kind: "directory",
      entryObjectIdentity: "obj:src-directory",
    });

    expect(outcomes).toEqual([
      {
        documentId: id,
        status: "adopted",
        path: `${TARGET}\\nested\\b.ts`,
      },
    ]);
    expect(harness.manager.getSession(id)!.path).toBe(`${TARGET}\\nested\\b.ts`);
  });

  it("leaves a session alone when the relocation source is a different location", async () => {
    const harness = createHarness();
    harness.files.addFile(SMALL_A, "alpha");
    const opened = await harness.manager.openPath(SMALL_A);
    const id = opened.status === "opened" ? opened.documentId : "";

    const identity = harness.files.objectIdentityFor(SMALL_A);
    harness.files.removeFile(SMALL_A);
    harness.files.addFile("C:\\work\\alias\\a.txt", "alpha");
    harness.files.setObjectIdentity("C:\\work\\alias\\a.txt", identity);

    // The source the caller names is not the session's location under any casing,
    // so the document is not a candidate at all: it keeps its binding and stays
    // subject to 005 rather than being rebased on a guess.
    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: "C:\\work\\alias",
      newPath: "C:\\work\\lib",
      kind: "directory",
      entryObjectIdentity: "obj:dir",
    });

    expect(outcomes).toEqual([]);
    expect(harness.manager.getSession(id)!.path).toBe(SMALL_A);
  });

  it("does not adopt an equivalent-casing source on a case-sensitive filesystem", async () => {
    const harness = createHarness();
    // The backend reports a case-sensitive volume: `REAL` and `real` are two
    // different directories, so a relocation of one must never rebase a document
    // that lives in the other (FR-045, FR-056).
    harness.files.caseSensitiveKeys = true;

    const SOURCE = "C:\\work\\real";
    const OTHER = "C:\\work\\REAL";
    const DOCUMENT = `${SOURCE}\\a.ts`;
    harness.files.addDirectory(SOURCE);
    harness.files.addFile(DOCUMENT, "alpha");
    const opened = await harness.manager.openPath(DOCUMENT);
    const id = opened.status === "opened" ? opened.documentId : "";

    const identity = harness.files.objectIdentityFor(DOCUMENT);
    harness.files.removeFile(DOCUMENT);
    harness.files.addFile("C:\\work\\lib\\a.ts", "alpha");
    harness.files.setObjectIdentity("C:\\work\\lib\\a.ts", identity);

    // The request names the *other* directory, which only a case-folding
    // comparison would treat as the document's location.
    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: OTHER,
      newPath: "C:\\work\\lib",
      kind: "directory",
      entryObjectIdentity: "obj:dir",
    });

    expect(outcomes).toEqual([]);
    expect(harness.manager.getSession(id)!.path).toBe(DOCUMENT);
  });

  it("does not adopt a same-tail entry that lives in another directory", async () => {
    const harness = createHarness();
    const DOCUMENT = "C:\\work\\other\\a.ts";
    harness.files.addDirectory("C:\\work\\other");
    harness.files.addFile(DOCUMENT, "alpha");
    const opened = await harness.manager.openPath(DOCUMENT);
    const id = opened.status === "opened" ? opened.documentId : "";

    // The same object is reachable at the document's path *and* at the moved
    // directory's destination, so only canonical containment may decide whether
    // this session followed the move — a matching tail must prove nothing.
    const identity = harness.files.objectIdentityFor(DOCUMENT);
    harness.files.addDirectory("C:\\work\\src");
    harness.files.addFile("C:\\work\\lib\\a.ts", "alpha");
    harness.files.setObjectIdentity("C:\\work\\lib\\a.ts", identity);

    const outcomes = await harness.manager.adoptExternalRelocation({
      oldPath: "C:\\work\\src",
      newPath: "C:\\work\\lib",
      kind: "directory",
      entryObjectIdentity: "obj:dir",
    });

    expect(outcomes).toEqual([]);
    expect(harness.manager.getSession(id)!.path).toBe(DOCUMENT);
  });
