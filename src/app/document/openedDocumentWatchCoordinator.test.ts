import { describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";

// The module-boundary audit reads the 005 sources verbatim. `?raw` is Vite's
// supported way to import a file as text (typed through `vite/client`), so the
// audit needs no Node filesystem types in this browser-targeted project.
import filesystemWatcherSource from "../../services/filesystemWatcher.ts?raw";
import watchEventNormalizerSource from "../../services/watchEventNormalizer.ts?raw";
import diskValidationSource from "./diskValidation.ts?raw";
import internalFsOperationGuardSource from "./internalFsOperationGuard.ts?raw";
import coordinatorSource from "./openedDocumentWatchCoordinator.ts?raw";

import type {
  DocumentPathInspection,
  DiskRevision,
  FileCommandError,
  FileService,
  OpenTextFileResult,
  ResolvedPathIdentity,
  WriteTextFileRequest,
} from "../../services/fileService";
import type {
  FilesystemWatcherService,
  WatchEventPayload,
  WatchScope,
  WatchSubscriptionHandle,
} from "../../services/filesystemWatcher";
import type { HintScheduler } from "../../services/watchEventNormalizer";
import type { WatchInterestChange } from "./documentManager";
import { DiskValidator } from "./diskValidation";
import type { DiskBinding } from "./diskValidation";
import type { DocumentWatchPort } from "./openedDocumentWatchCoordinator";
import { OpenedDocumentWatchCoordinator } from "./openedDocumentWatchCoordinator";
import { InternalFsOperationGuard } from "./internalFsOperationGuard";
import type { CapturedWatchHint } from "./internalFsOperationGuard";
import {
  NEW_DOCUMENT_FORMAT,
  type DocumentId,
  type DocumentSession,
  type ExternalState,
} from "./documentSession";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The fake filesystem behind the real `DiskValidator`.
 *
 * It records every inspection and every content read, which is what makes the
 * "no full-content reads for an unchanged document" requirement (SC-008)
 * assertable instead of a matter of opinion.
 */
class FakeDisk implements FileService {
  readonly inspections: string[] = [];
  readonly reads: string[] = [];
  /** Existing files: path -> content. A path with no entry is missing. */
  private readonly files = new Map<string, string>();
  /** Reported revisions; absent means "size of the contents, time 0". */
  private readonly revisions = new Map<string, DiskRevision>();
  /** Paths reported `unreadable` with the given message. */
  readonly unreadable = new Map<string, string>();
  /** Holds every read open, so a test can close a document mid-validation. */
  holdReads = false;
  private pendingReads: Array<() => void> = [];
  readError: FileCommandError | null = null;

  write(path: string, text: string): void {
    this.files.set(this.key(path), text);
  }

  remove(path: string): void {
    this.files.delete(this.key(path));
  }

  /** Reports a revision that no longer matches what the document adopted. */
  setRevision(path: string, revision: DiskRevision): void {
    this.revisions.set(this.key(path), revision);
  }

  readCount(): number {
    return this.reads.length;
  }

  releaseReads(): void {
    const pending = this.pendingReads;
    this.pendingReads = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  textFor(path: string): string | undefined {
    return this.files.get(this.key(path));
  }

  inspectDocumentPath(path: string): Promise<DocumentPathInspection> {
    this.inspections.push(path);
    const key = this.key(path);
    const message = this.unreadable.get(key);
    if (message !== undefined) {
      return Promise.resolve({
        requestedPath: path,
        canonicalPath: null,
        comparisonKey: key,
        state: "unreadable",
        diskRevision: null,
        message,
      });
    }

    const text = this.files.get(key);
    if (text === undefined) {
      return Promise.resolve({
        requestedPath: path,
        canonicalPath: null,
        comparisonKey: null,
        state: "missing",
        diskRevision: null,
        message: null,
      });
    }

    return Promise.resolve({
      requestedPath: path,
      canonicalPath: path,
      comparisonKey: key,
      state: "file",
      diskRevision:
        this.revisions.get(key) ??
        { size: text.length, modifiedTimeMillis: 0 },
      message: null,
    });
  }

  /** Validation never creates anything, so a call here is a test bug. */
  createTextFileIfAbsent(): Promise<void> {
    return Promise.reject(new Error("not used by these tests"));
  }
  readTextFile(path: string): Promise<OpenTextFileResult> {
    this.reads.push(path);
    if (this.readError !== null) {
      return Promise.reject(this.readError);
    }

    const text = this.files.get(this.key(path));
    if (text === undefined) {
      return Promise.reject({
        code: "io_read",
        message: `No file at ${path}`,
      } satisfies FileCommandError);
    }

    const result: OpenTextFileResult = {
      text,
      format: { ...NEW_DOCUMENT_FORMAT },
    };
    if (!this.holdReads) {
      return Promise.resolve(result);
    }

    return new Promise<OpenTextFileResult>((resolve) => {
      this.pendingReads.push(() => resolve(result));
    });
  }

  /** Not used by validation; present because `FileService` requires it. */
  inspectFilePath(): Promise<ResolvedPathIdentity> {
    return Promise.reject(new Error("not used by these tests"));
  }

  /** Not used by validation; present because `FileService` requires it. */
  writeTextFile(_request: WriteTextFileRequest): Promise<void> {
    return Promise.reject(new Error("not used by these tests"));
  }

  private key(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
  }
}

/** One fake open document, standing in for a `DocumentSession`. */
interface FakeDocument {
  id: DocumentId;
  path: string;
  comparisonKey: string;
  canonicalPath: string;
  /** The adopted disk baseline. */
  baseline: string;
  /** The live editor content. */
  buffer: string;
  dirty: boolean;
  externalState: ExternalState;
  generation: number;
  revision: DiskRevision | null;
  /** 006 object token carried by this binding (opaque to 005). */
  objectIdentity: string | null;
}

/**
 * A recording `DocumentWatchPort`.
 *
 * The coordinator is defined against this narrow port precisely so its own
 * behaviour — coalescing, staleness, own-operation reconciliation — can be tested
 * deterministically, without an editor, a dialog service or a real window.
 */
class FakeDocumentPort implements DocumentWatchPort {
  readonly documents = new Map<DocumentId, FakeDocument>();
  /** Every port method call, in order; used to prove what 005 may reach. */
  readonly calls: string[] = [];
  readonly validationErrors: string[] = [];

  private readonly interestListeners = new Set<
    (change: WatchInterestChange) => void
  >();
  private readonly activationListeners = new Set<(id: DocumentId) => void>();
  private readonly reconciliationListeners = new Set<
    (hints: readonly CapturedWatchHint[]) => void
  >();
  private sequence = 0;

  /** Registers a bound document with an adopted revision equal to its contents. */
  addBound(
    path: string,
    text: string,
    options: { dirty?: boolean; revision?: DiskRevision | null } = {},
  ): FakeDocument {
    this.sequence += 1;
    const key = path.replace(/\\/g, "/").toLowerCase();
    const document: FakeDocument = {
      id: `doc-${this.sequence}`,
      path,
      comparisonKey: key,
      canonicalPath: path,
      baseline: text,
      buffer: options.dirty === true ? `${text} (edited)` : text,
      dirty: options.dirty === true,
      externalState: "normal",
      generation: 0,
      revision:
        options.revision === undefined
          ? { size: text.length, modifiedTimeMillis: 0 }
          : options.revision,
      objectIdentity: `fake:${key}`,
    };
    this.documents.set(document.id, document);
    return document;
  }

  /** Announces a new binding, as the manager does after an Open. */
  announceBound(document: FakeDocument): void {
    this.notifyInterest({
      type: "bound",
      documentId: document.id,
      path: document.path,
      identity: this.identityOf(document),
    });
  }

  /** Migrates a document's path, as Save As / an internal Rename does. */
  announceRebound(
    document: FakeDocument,
    path: string,
    cause?: "external-relocation",
  ): void {
    const previousPath = document.path;
    const previousIdentity = this.identityOf(document);
    const key = path.replace(/\\/g, "/").toLowerCase();
    document.path = path;
    document.comparisonKey = key;
    document.canonicalPath = path;
    document.generation += 1;
    this.notifyInterest({
      type: "rebound",
      documentId: document.id,
      previousPath,
      previousIdentity,
      path,
      identity: this.identityOf(document),
      ...(cause === undefined ? {} : { cause }),
    });
  }

  /** Removes a document, as close does. */
  announceUnbound(document: FakeDocument): void {
    const identity = this.identityOf(document);
    this.documents.delete(document.id);
    this.notifyInterest({
      type: "unbound",
      documentId: document.id,
      path: identity.requestedPath,
      identity,
    });
  }

  /** Announces a user Tab activation. */
  activate(documentId: DocumentId): void {
    for (const listener of this.activationListeners) {
      listener(documentId);
    }
  }

  /** Announces hints an internal operation could not reconcile. */
  reconcile(hints: readonly CapturedWatchHint[]): void {
    for (const listener of this.reconciliationListeners) {
      listener(hints);
    }
  }

  /** Applies a validation error the coordinator reported. */
  recordValidationError(message: string): void {
    this.validationErrors.push(message);
  }

  /**
   * How many manager listeners each channel currently has (test seam, T062).
   *
   * A superseded start run that installed its own subscriptions would show up
   * here as a count above one, which is the direct proof that it must not.
   */
  watchInterestListenerCount(): number {
    return this.interestListeners.size;
  }

  activationListenerCount(): number {
    return this.activationListeners.size;
  }

  reconciliationListenerCount(): number {
    return this.reconciliationListeners.size;
  }

  /* -------- DocumentWatchPort -------- */

  getSession(id: DocumentId): DocumentSession | undefined {
    const document = this.documents.get(id);
    return document === undefined ? undefined : this.toSession(document);
  }

  listSessions(): readonly DocumentSession[] {
    return [...this.documents.values()].map((document) =>
      this.toSession(document),
    );
  }

  getBinding(id: DocumentId): DiskBinding | null {
    this.calls.push(`getBinding:${id}`);
    const document = this.documents.get(id);
    if (document === undefined) {
      return null;
    }
    return {
      documentId: document.id,
      path: document.path,
      comparisonKey: document.comparisonKey,
      generation: document.generation,
      identity: this.identityOf(document),
    };
  }

  isBindingCurrent(binding: DiskBinding): boolean {
    this.calls.push(`isBindingCurrent:${binding.documentId}`);
    const document = this.documents.get(binding.documentId);
    if (document === undefined) {
      return false;
    }
    return (
      document.generation === binding.generation &&
      document.path === binding.path &&
      document.comparisonKey === binding.comparisonKey
    );
  }

  adoptVerifiedIdentity(
    binding: DiskBinding,
    identity: ResolvedPathIdentity,
  ): boolean {
    this.calls.push(`adoptVerifiedIdentity:${binding.documentId}`);
    const document = this.documents.get(binding.documentId);
    if (document === undefined || !this.isBindingCurrent(binding)) {
      return false;
    }
    document.revision = identity.diskRevision;
    document.externalState = "normal";
    return true;
  }

  applyValidatedDiskSnapshot(
    binding: DiskBinding,
    snapshot: { identity: ResolvedPathIdentity; content: OpenTextFileResult },
    options: { replaceDirty?: boolean } = {},
  ): "reloaded" | "unchanged" | "external-modified" | "stale" {
    this.calls.push(`applyValidatedDiskSnapshot:${binding.documentId}`);
    const document = this.documents.get(binding.documentId);
    if (document === undefined || !this.isBindingCurrent(binding)) {
      return "stale";
    }
    document.revision = snapshot.identity.diskRevision;
    if (snapshot.content.text === document.baseline) {
      document.externalState = "normal";
      return "unchanged";
    }
    if (document.dirty && options.replaceDirty !== true) {
      document.externalState = "modified";
      return "external-modified";
    }
    document.baseline = snapshot.content.text;
    document.buffer = snapshot.content.text;
    document.dirty = false;
    document.externalState = "normal";
    return "reloaded";
  }

  markExternalState(binding: DiskBinding, state: ExternalState): boolean {
    this.calls.push(`markExternalState:${binding.documentId}:${state}`);
    const document = this.documents.get(binding.documentId);
    if (document === undefined || !this.isBindingCurrent(binding)) {
      return false;
    }
    document.externalState = state;
    return true;
  }

  async markValidationError(
    binding: DiskBinding,
    error: FileCommandError,
  ): Promise<boolean> {
    this.calls.push(`markValidationError:${binding.documentId}`);
    const document = this.documents.get(binding.documentId);
    if (document === undefined || !this.isBindingCurrent(binding)) {
      return false;
    }
    this.recordValidationError(error.message);
    return true;
  }

  subscribeWatchInterest(
    listener: (change: WatchInterestChange) => void,
  ): () => void {
    this.interestListeners.add(listener);
    return () => {
      this.interestListeners.delete(listener);
    };
  }

  subscribeActivation(listener: (id: DocumentId) => void): () => void {
    this.activationListeners.add(listener);
    return () => {
      this.activationListeners.delete(listener);
    };
  }

  subscribeReconciliation(
    listener: (hints: readonly CapturedWatchHint[]) => void,
  ): () => void {
    this.reconciliationListeners.add(listener);
    return () => {
      this.reconciliationListeners.delete(listener);
    };
  }

  private notifyInterest(change: WatchInterestChange): void {
    for (const listener of this.interestListeners) {
      listener(change);
    }
  }

  private identityOf(document: FakeDocument): ResolvedPathIdentity {
    return {
      requestedPath: document.path,
      canonicalPath: document.canonicalPath,
      comparisonKey: document.comparisonKey,
      kind: "file",
      diskRevision: document.revision,
      // 005 ignores the 006 object token; the fake reports the one its binding
      // holds so the refreshed identity stays contract-complete.
      objectIdentity: document.objectIdentity,
    };
  }

  private toSession(document: FakeDocument): DocumentSession {
    const state = EditorState.create({ doc: document.buffer });
    return {
      id: document.id,
      path: document.path,
      pathIdentity: this.identityOf(document),
      displayName: document.path,
      format: { ...NEW_DOCUMENT_FORMAT },
      dirty: document.dirty,
      savedBaseline: Text.of(document.baseline.split("\n")),
      editorState: state,
      viewState: { scrollTop: 0, scrollLeft: 0 },
      latestSaveGeneration: 0,
      externalState: document.externalState,
      bindingGeneration: document.generation,
    };
  }
}

/** Records subscriptions and lets a test inject backend payloads. */
class FakeFilesystemWatcher implements FilesystemWatcherService {
  readonly started: Array<{ path: string; scope: WatchScope }> = [];
  readonly stopped: Array<number> = [];
  /** Makes the next `subscribe` reject, modelling an unwatchable path. */
  failNextSubscribe = false;
  /**
   * Holds every `listen` open until {@link releaseListen} runs, so a test can
   * keep one lifecycle run suspended inside its listener installation (T062).
   *
   * The listener itself is installed when `listen` is called — that is what the
   * real backend does — only the unlisten closure the coordinator needs is
   * withheld, which is exactly the window the epoch token has to cover.
   */
  holdListen = false;
  /**
   * How many times an installed listener was actually released.
   *
   * A listener that was already removed cannot be released twice, so this is a
   * precise record of "this listener still existed and was dropped" (T062).
   */
  unlistenCount = 0;

  private readonly listeners = new Set<(payload: WatchEventPayload) => void>();
  private readonly idsByPath = new Map<string, number>();
  private pendingListens: Array<() => void> = [];
  private nextId = 1;

  subscribe(
    path: string,
    scope: WatchScope,
  ): Promise<WatchSubscriptionHandle> {
    this.started.push({ path, scope });
    if (this.failNextSubscribe) {
      this.failNextSubscribe = false;
      return Promise.reject({
        code: "path_resolution",
        message: `Cannot watch ${path}`,
      } satisfies FileCommandError);
    }

    const subscriptionId = this.nextId;
    this.nextId += 1;
    this.idsByPath.set(path, subscriptionId);
    let stopped = false;

    return Promise.resolve({
      subscriptionId,
      path,
      watchedPath: path,
      scope,
      stop: () => {
        if (!stopped) {
          stopped = true;
          this.stopped.push(subscriptionId);
        }
        return Promise.resolve();
      },
    });
  }

  listen(listener: (payload: WatchEventPayload) => void): Promise<() => void> {
    this.listeners.add(listener);
    const unlisten = () => {
      if (this.listeners.delete(listener)) {
        this.unlistenCount += 1;
      }
    };

    if (!this.holdListen) {
      return Promise.resolve(unlisten);
    }

    return new Promise<() => void>((resolve) => {
      this.pendingListens.push(() => resolve(unlisten));
    });
  }

  /** Releases every held `listen`, as a completing backend handshake would. */
  releaseListen(): void {
    const pending = this.pendingListens;
    this.pendingListens = [];
    for (const release of pending) {
      release();
    }
  }

  /** How many listeners are currently installed (test seam, T062). */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** The subscription id the coordinator received for `path`. */
  subscriptionIdFor(path: string): number {
    const id = this.idsByPath.get(path);
    if (id === undefined) {
      throw new Error(`No subscription for ${path}`);
    }
    return id;
  }

  /** Emits one change hint for a subscribed path. */
  emitChange(
    path: string,
    hint: "created" | "changed" | "removed" | "other",
    options: { renameTarget?: string | null } = {},
  ): void {
    const renameTarget = options.renameTarget ?? null;
    this.emit({
      type: "change",
      subscriptionId: this.subscriptionIdFor(path),
      scope: "nonRecursive",
      watchedPath: path,
      path,
      hint,
      renameTarget,
      // 005's subscription watches the parent directory, so the relative fields
      // are present on the wire even though this consumer ignores them.
      relativePath: null,
      renameTargetRelativePath: null,
    });
  }

  /** Emits one change hint carrying an explicit subscription id. */
  emitRaw(payload: WatchEventPayload): void {
    this.emit(payload);
  }

  private emit(payload: WatchEventPayload): void {
    for (const listener of [...this.listeners]) {
      listener(payload);
    }
  }
}

/** Runs coalescing windows on demand, so no test waits on a real timer. */
class ManualScheduler implements HintScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();
  scheduleCount = 0;

  schedule(callback: () => void, _delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduleCount += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.callbacks.delete(handle);
  }

  /** Fires every armed window, as elapsed time would. */
  fire(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }

  pendingCount(): number {
    return this.callbacks.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  coordinator: OpenedDocumentWatchCoordinator;
  port: FakeDocumentPort;
  watcher: FakeFilesystemWatcher;
  disk: FakeDisk;
  guard: InternalFsOperationGuard;
  scheduler: ManualScheduler;
}

async function createHarness(): Promise<Harness> {
  const port = new FakeDocumentPort();
  const watcher = new FakeFilesystemWatcher();
  const disk = new FakeDisk();
  const guard = new InternalFsOperationGuard();
  const scheduler = new ManualScheduler();
  const coordinator = new OpenedDocumentWatchCoordinator({
    documents: port,
    validator: new DiskValidator({ fileService: disk }),
    watcher,
    guard,
    coalesceWindowMs: 100,
    scheduler,
  });

  await coordinator.start();

  return { coordinator, port, watcher, disk, guard, scheduler };
}

/** Opens a document through the coordinator, as the manager would. */
async function boundDocument(
  harness: Harness,
  path: string,
  text: string,
  options: { dirty?: boolean } = {},
) {
  harness.disk.write(path, text);
  const document = harness.port.addBound(path, text, options);
  harness.port.announceBound(document);
  await harness.coordinator.whenIdle();
  return document;
}

/**
 * Lets the coordinator's asynchronous chain advance without waiting for held I/O.
 *
 * `whenIdle` is the right tool for "the work finished", but a test that holds a
 * read open needs the chain to reach that read and stop there.
 */
async function settleMicrotasks(times = 16): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/* US4 — the hint channel stays a hint channel                                */
/* -------------------------------------------------------------------------- */

describe("OpenedDocumentWatchCoordinator event handling (US4, T041)", () => {
  it("coalesces a burst of duplicate hints into one validation per document (FR-011, SC-004)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const inspectionsBefore = harness.disk.inspections.length;

    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    expect(harness.scheduler.scheduleCount).toBe(1);
    // A burst is coalesced before any disk work happens.
    expect(harness.disk.inspections.length).toBe(inspectionsBefore);

    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length - inspectionsBefore).toBe(1);
    expect(document.externalState).toBe("normal");
  });

  it("derives the final state from validation rather than the raw event order (FR-007)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");

    // A remove/create burst that ends with the file present and different.
    harness.disk.write("C:\\work\\a.txt", "replaced");
    harness.watcher.emitChange("C:\\work\\a.txt", "removed");
    harness.watcher.emitChange("C:\\work\\a.txt", "created");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
    expect(harness.port.documents.get(document.id)!.buffer).toBe("replaced");

    // The reverse order with the file actually gone converges to `missing`.
    const second = await boundDocument(harness, "C:\\work\\b.txt", "bravo");
    harness.disk.remove("C:\\work\\b.txt");
    harness.watcher.emitChange("C:\\work\\b.txt", "created");
    harness.watcher.emitChange("C:\\work\\b.txt", "removed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(second.id)!.externalState).toBe("missing");
  });

  it("turns an invalidation into a revalidation of every interest (FR-011, FR-038)", async () => {
    const harness = await createHarness();
    const first = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const second = await boundDocument(harness, "C:\\other\\b.txt", "bravo");
    harness.disk.write("C:\\work\\a.txt", "alpha changed");
    harness.disk.write("C:\\other\\b.txt", "bravo changed");
    const inspectionsBefore = harness.disk.inspections.length;

    harness.watcher.emitRaw({
      type: "invalidated",
      scope: "nonRecursive",
      watchedPath: null,
      reason: "backend overflow",
    });
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length - inspectionsBefore).toBe(2);
    expect(harness.port.documents.get(first.id)!.buffer).toBe("alpha changed");
    expect(harness.port.documents.get(second.id)!.buffer).toBe("bravo changed");
  });

  it("discovers a missed event when a tab is activated (FR-012, SC-005)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    // No hint at all: the realtime channel missed the change.
    harness.disk.write("C:\\work\\a.txt", "changed without a hint");

    harness.port.activate(document.id);
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed without a hint",
    );
    expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
  });

  it("ignores a hint whose subscription is no longer registered", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const subscriptionId = harness.watcher.subscriptionIdFor("C:\\work\\a.txt");
    harness.port.announceUnbound(document);
    await harness.coordinator.whenIdle();
    const inspectionsBefore = harness.disk.inspections.length;

    harness.watcher.emitRaw({
      type: "change",
      subscriptionId,
      scope: "nonRecursive",
      watchedPath: "C:\\work\\a.txt",
      path: "C:\\work\\a.txt",
      hint: "changed",
      renameTarget: null,
      relativePath: null,
      renameTargetRelativePath: null,
    });
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length).toBe(inspectionsBefore);
  });

  it("reports an unverifiable path without touching the document (FR-015, FR-043)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    harness.disk.unreadable.set("c:/work/a.txt", "locked by another program");

    harness.port.activate(document.id);
    await harness.coordinator.whenIdle();

    expect(harness.port.validationErrors).toEqual(["locked by another program"]);
    expect(harness.port.documents.get(document.id)!.buffer).toBe("alpha");
    expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
  });
});

/* -------------------------------------------------------------------------- */
/* Own operations                                                             */
/* -------------------------------------------------------------------------- */

describe("OpenedDocumentWatchCoordinator own-operation reconciliation (T042)", () => {
  it("does not turn a save's own notifications into an external conflict (FR-035, SC-006)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const operation = harness.guard.beginMutation({
      kind: "save",
      claims: [
        {
          path: document.path,
          comparisonKey: document.comparisonKey,
          effect: "write",
        },
      ],
    });

    // The write the operation itself performs, and the notification it produces.
    harness.disk.write("C:\\work\\a.txt", "alpha (edited)");
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    // The hint was offered to the guard, not validated as an outside change, so
    // no inspection happened beyond the post-subscription one.
    expect(harness.guard.pendingHintCount()).toBe(1);
    expect(harness.disk.inspections).toHaveLength(1);
    expect(harness.port.calls).not.toContain(
      `markExternalState:${document.id}:modified`,
    );

    expect(
      operation.settle({
        succeeded: true,
        confirmed: [{ comparisonKey: document.comparisonKey, exists: true }],
      }),
    ).toEqual({ status: "reconciled" });

    expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
    expect(harness.port.calls).not.toContain(
      `markExternalState:${document.id}:modified`,
    );
  });

  it("still surfaces an outside change that happened during an internal save (FR-036)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const operation = harness.guard.beginMutation({
      kind: "save",
      claims: [
        {
          path: document.path,
          comparisonKey: document.comparisonKey,
          effect: "write",
        },
      ],
    });

    // The file is gone, which no successful write can explain.
    harness.disk.remove("C:\\work\\a.txt");
    harness.watcher.emitChange("C:\\work\\a.txt", "removed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    const outcome = operation.settle({
      succeeded: true,
      confirmed: [{ comparisonKey: document.comparisonKey, exists: true }],
    });
    expect(outcome.status).toBe("diverged");

    // The manager forwards what the guard could not explain, and the coordinator
    // validates it like any other outside hint.
    harness.port.reconcile(
      outcome.status === "diverged" ? outcome.unreconciled : [],
    );
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.externalState).toBe("missing");
  });

  it("validates hints an operation could not confirm at all", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    harness.disk.write("C:\\work\\a.txt", "changed outside");

    harness.port.reconcile([
      {
        comparisonKey: document.comparisonKey,
        path: document.path,
        kind: "changed",
      },
    ]);
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed outside",
    );
  });

  it("revalidates every interest when a reconciliation reports invalidation", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    harness.disk.write("C:\\work\\a.txt", "changed outside");
    const inspectionsBefore = harness.disk.inspections.length;

    harness.port.reconcile([
      {
        comparisonKey: document.comparisonKey,
        path: document.path,
        kind: "invalidated",
      },
    ]);
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length).toBe(inspectionsBefore + 1);
    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed outside",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Races                                                                      */
/* -------------------------------------------------------------------------- */

describe("OpenedDocumentWatchCoordinator stale completions (T043, SC-007)", () => {
  it("revalidates after a subscription is established, closing the read-to-watch gap (FR-044)", async () => {
    const harness = await createHarness();
    harness.disk.write("C:\\work\\a.txt", "alpha");
    const document = harness.port.addBound("C:\\work\\a.txt", "alpha");

    // The disk changes between the read that produced the baseline and the moment
    // the subscription becomes active.
    harness.disk.write("C:\\work\\a.txt", "changed in the gap");
    harness.port.announceBound(document);
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed in the gap",
    );
    expect(harness.port.documents.get(document.id)!.dirty).toBe(false);
  });

  it("does not apply a validation whose document was closed while it ran (FR-039)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    harness.disk.write("C:\\work\\a.txt", "changed on disk");
    harness.disk.holdReads = true;

    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await settleMicrotasks();
    expect(harness.disk.reads).toHaveLength(1);

    // The user closes the tab while the read is still open.
    harness.port.announceUnbound(document);
    harness.disk.releaseReads();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.has(document.id)).toBe(false);
    expect(harness.port.calls).not.toContain(
      `applyValidatedDiskSnapshot:${document.id}`,
    );
  });

  it("does not apply an old-path result after Save As rebound the document (FR-039)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    harness.disk.write("C:\\work\\a.txt", "changed on the old path");
    harness.disk.holdReads = true;

    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await settleMicrotasks();

    // Save As moves the document to a new path while the old read is in flight.
    harness.disk.write("C:\\work\\new.txt", "alpha");
    harness.port.announceRebound(document, "C:\\work\\new.txt");
    await settleMicrotasks();

    // The stale read finally finishes, describing the path the document no longer
    // uses. It must be discarded.
    harness.disk.holdReads = false;
    harness.disk.releaseReads();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.path).toBe(
      "C:\\work\\new.txt",
    );
    expect(harness.port.documents.get(document.id)!.buffer).toBe("alpha");
  });

  it("stops the old subscription and starts the new one on a path change (FR-004, T047)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const oldSubscription = harness.watcher.subscriptionIdFor("C:\\work\\a.txt");

    harness.disk.write("C:\\work\\new.txt", "alpha");
    harness.port.announceRebound(document, "C:\\work\\new.txt");
    await harness.coordinator.whenIdle();

    expect(harness.watcher.stopped).toContain(oldSubscription);
    expect(harness.watcher.started.map((entry) => entry.path)).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\new.txt",
    ]);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);
  });

  it("lets a newer trigger retire an older in-flight validation (FR-039)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    harness.disk.write("C:\\work\\a.txt", "first change");
    harness.disk.holdReads = true;

    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await settleMicrotasks();

    // A second trigger arrives while the first read is still open; its result is
    // the one that must win.
    harness.disk.write("C:\\work\\a.txt", "second change");
    harness.port.activate(document.id);
    await settleMicrotasks();
    harness.disk.holdReads = false;
    harness.disk.releaseReads();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe("second change");
  });

  it("releases every subscription on dispose and stops listening (T047)", async () => {
    const harness = await createHarness();
    await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    await boundDocument(harness, "C:\\other\\b.txt", "bravo");
    const inspectionsBefore = harness.disk.inspections.length;

    await harness.coordinator.dispose();

    expect(harness.watcher.stopped).toHaveLength(2);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(0);

    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();
    expect(harness.disk.inspections.length).toBe(inspectionsBefore);
  });

  it("keeps working when a path cannot be watched at all", async () => {
    const harness = await createHarness();
    harness.disk.write("C:\\work\\a.txt", "alpha");
    const document = harness.port.addBound("C:\\work\\a.txt", "alpha");
    harness.watcher.failNextSubscribe = true;

    harness.port.announceBound(document);
    await harness.coordinator.whenIdle();

    // Nothing was subscribed, but the document itself is untouched.
    expect(harness.coordinator.activeSubscriptionCount()).toBe(0);
    expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
    expect(harness.port.documents.get(document.id)!.buffer).toBe("alpha");
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle generations (T062, FR-003, FR-039)                               */
/* -------------------------------------------------------------------------- */

/**
 * Reproduces the lifecycle overlap T062 is about.
 *
 * A first `start()` is suspended inside its `listen` — the backend has not handed
 * out the unlisten closure yet — `dispose()` supersedes it, which is exactly what
 * a React Strict Mode cleanup does, and a second `start()` then runs to
 * completion. The suspended run's listener is only released by the caller, so it
 * resumes long after the run that replaced it is already live.
 */
async function startSupersededRun(harness: Harness): Promise<{
  staleStart: Promise<void>;
  releaseStaleListen: () => void;
}> {
  // Ends whatever run the harness started with, so the suspended `start()` below
  // is the one a later dispose has to invalidate.
  await harness.coordinator.dispose();

  harness.watcher.holdListen = true;
  const staleStart = harness.coordinator.start();
  await settleMicrotasks();

  // The cleanup that supersedes the suspended run.
  await harness.coordinator.dispose();

  // The remount: its listener resolves immediately, so it becomes the live run.
  // `whenIdle` deliberately is not used here — the suspended run is still an
  // in-flight promise, and only the caller releases it.
  harness.watcher.holdListen = false;
  await harness.coordinator.start();

  return {
    staleStart,
    releaseStaleListen: () => {
      harness.watcher.releaseListen();
    },
  };
}

describe("OpenedDocumentWatchCoordinator lifecycle generations (T062)", () => {
  /**
   * FR-003 / T062: a superseded start may only release what it obtained itself.
   */
  it("leaves exactly one listener and subscription set when an older start is superseded (T062, FR-003)", async () => {
    const harness = await createHarness();
    // Bound but never announced, so only the live run's registration sweep can
    // be the one that subscribes to it.
    harness.disk.write("C:\\work\\a.txt", "alpha");
    harness.port.addBound("C:\\work\\a.txt", "alpha");

    const { staleStart, releaseStaleListen } = await startSupersededRun(harness);
    // The live run's sweep registered the already-bound document exactly once.
    expect(harness.watcher.started.map((entry) => entry.path)).toEqual([
      "C:\\work\\a.txt",
    ]);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);

    const unlistensBefore = harness.watcher.unlistenCount;
    releaseStaleListen();
    await staleStart;
    await harness.coordinator.whenIdle();

    // The stale run released the listener it had obtained...
    expect(harness.watcher.unlistenCount - unlistensBefore).toBe(1);
    // ...and installed nothing else: one listener, one subscription, no duplicate.
    expect(harness.watcher.listenerCount()).toBe(1);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);
    expect(harness.watcher.started.map((entry) => entry.path)).toEqual([
      "C:\\work\\a.txt",
    ]);
  });

  /**
   * FR-011 / FR-039 / T062: the surviving run's hint channel is the only one that
   * may reach the document, so one hint causes exactly one validation.
   */
  it("processes a hint exactly once after an overlapping start/dispose/start (T062, FR-011, FR-039)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");

    const { staleStart, releaseStaleListen } = await startSupersededRun(harness);
    releaseStaleListen();
    await staleStart;
    await harness.coordinator.whenIdle();

    // Only the surviving run's listener may remain, so only it consumes the hint
    // below: a duplicated listener would keep processing the same payloads.
    expect(harness.watcher.listenerCount()).toBe(1);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);

    harness.disk.write("C:\\work\\a.txt", "changed externally");
    const inspectionsBefore = harness.disk.inspections.length;
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    // One hint, one inspection, one applied state — not two of anything.
    expect(harness.disk.inspections.length - inspectionsBefore).toBe(1);
    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed externally",
    );
    expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
  });

  /**
   * FR-003 / T062: the stale run must not subscribe to the manager either, which
   * is what keeps every later interest notification single.
   */
  it("never installs a superseded run's manager subscriptions (T062, FR-003)", async () => {
    const harness = await createHarness();
    const { staleStart, releaseStaleListen } = await startSupersededRun(harness);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(0);

    releaseStaleListen();
    await staleStart;
    await harness.coordinator.whenIdle();

    // Only the live run subscribed to the manager: a stale run that had also
    // installed its own listeners would double every interest notification.
    expect(harness.port.watchInterestListenerCount()).toBe(1);
    expect(harness.port.activationListenerCount()).toBe(1);
    expect(harness.port.reconciliationListenerCount()).toBe(1);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(0);

    // An interest announced after the overlap therefore yields exactly one
    // subscription, and the live count never exceeds one at any point observed.
    harness.disk.write("C:\\work\\a.txt", "alpha");
    const document = harness.port.addBound("C:\\work\\a.txt", "alpha");
    harness.port.announceBound(document);
    await harness.coordinator.whenIdle();

    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);
    expect(
      harness.watcher.started.filter((entry) => entry.path === "C:\\work\\a.txt"),
    ).toHaveLength(1);

    // The surviving run still owns the channel.
    harness.disk.write("C:\\work\\a.txt", "changed externally");
    const inspectionsBefore = harness.disk.inspections.length;
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length - inspectionsBefore).toBe(1);
    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed externally",
    );
  });

  /**
   * FR-003 / T062: two sequential `start()` calls with no intervening `dispose()`
   * stay in the same generation, so the second one installs nothing.
   */
  it("installs only one listener when start() is called twice while running (T062, FR-003)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const listenersBefore = harness.watcher.listenerCount();
    const subscriptionsBefore = harness.watcher.started.length;

    await harness.coordinator.start();
    await harness.coordinator.start();
    await harness.coordinator.whenIdle();

    expect(harness.watcher.listenerCount()).toBe(listenersBefore);
    expect(harness.watcher.started.length).toBe(subscriptionsBefore);
    expect(harness.port.watchInterestListenerCount()).toBe(1);
    expect(harness.port.activationListenerCount()).toBe(1);
    expect(harness.port.reconciliationListenerCount()).toBe(1);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);

    harness.disk.write("C:\\work\\a.txt", "changed externally");
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed externally",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Scope: 005 watches opened documents and nothing else                       */
/* -------------------------------------------------------------------------- */

describe("OpenedDocumentWatchCoordinator scope (T051, T053, FR-001, FR-040)", () => {
  it("subscribes exactly the bound documents, sharing nothing in the frontend", async () => {
    const harness = await createHarness();
    // Three files in one directory plus two in unrelated directories, one of them
    // outside any workspace. 005 treats them identically (FR-001, FR-006).
    await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    await boundDocument(harness, "C:\\work\\b.txt", "bravo");
    await boundDocument(harness, "C:\\work\\c.txt", "charlie");
    await boundDocument(harness, "C:\\elsewhere\\d.txt", "delta");
    await boundDocument(harness, "D:\\outside\\workspace\\e.txt", "echo");

    expect(harness.watcher.started.map((entry) => entry.path)).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\b.txt",
      "C:\\work\\c.txt",
      "C:\\elsewhere\\d.txt",
      "D:\\outside\\workspace\\e.txt",
    ]);
    // Non-recursive parent watching is the 005 policy; sharing one underlying
    // backend watch per parent directory is refcounted in Rust and pinned there.
    expect(
      harness.watcher.started.every((entry) => entry.scope === "nonRecursive"),
    ).toBe(true);
    expect(harness.coordinator.activeSubscriptionCount()).toBe(5);
  });

  it("routes a hint only to the document that subscribed to it", async () => {
    const harness = await createHarness();
    const first = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const second = await boundDocument(harness, "C:\\work\\b.txt", "bravo");
    const inspectionsBefore = harness.disk.inspections.slice();

    harness.disk.write("C:\\work\\a.txt", "alpha changed");
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    const requested = harness.disk.inspections.slice(inspectionsBefore.length);
    expect(requested).toEqual(["C:\\work\\a.txt"]);
    expect(harness.port.documents.get(first.id)!.buffer).toBe("alpha changed");
    expect(harness.port.documents.get(second.id)!.buffer).toBe("bravo");
  });

  it("touches only document state, never an Explorer or Workspace operation (FR-040, SC-009)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    harness.disk.remove("C:\\work\\a.txt");

    harness.watcher.emitChange("C:\\work\\a.txt", "removed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    // The port has no Explorer operation at all, so 005 cannot reach one. This
    // asserts the *reachable* surface: an external delete becomes `missing` on the
    // document and never a tree edit or a session removal (FR-028, FR-040).
    expect(harness.port.documents.has(document.id)).toBe(true);
    expect(harness.port.documents.get(document.id)!.externalState).toBe("missing");
    const documentStateCalls = new Set([
      "getBinding",
      "isBindingCurrent",
      "adoptVerifiedIdentity",
      "applyValidatedDiskSnapshot",
      "markExternalState",
      "markValidationError",
    ]);
    for (const call of harness.port.calls) {
      expect(documentStateCalls.has(call.split(":")[0])).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Performance                                                                */
/* -------------------------------------------------------------------------- */

describe("OpenedDocumentWatchCoordinator performance (T054, SC-008)", () => {
  it("performs one cheap inspection per document and zero content reads on a focus pass", async () => {
    const harness = await createHarness();
    const documents = [];
    for (let index = 0; index < 50; index += 1) {
      const path = `C:\\bulk\\file${index}.txt`;
      harness.disk.write(path, `contents ${index}`);
      documents.push(harness.port.addBound(path, `contents ${index}`));
    }
    for (const document of documents) {
      harness.port.announceBound(document);
    }
    await harness.coordinator.whenIdle();
    const inspectionsBefore = harness.disk.inspections.length;

    // The focus handler must not block on disk work: the call returns immediately.
    harness.coordinator.validateAllOnWindowFocus();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length - inspectionsBefore).toBe(50);
    expect(harness.disk.readCount()).toBe(0);
    for (const document of documents) {
      expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
    }
  });

  it("reads content only for the documents whose revision changed", async () => {
    const harness = await createHarness();
    const documents = [];
    for (let index = 0; index < 50; index += 1) {
      const path = `C:\\bulk\\file${index}.txt`;
      harness.disk.write(path, `contents ${index}`);
      documents.push(harness.port.addBound(path, `contents ${index}`));
    }
    for (const document of documents) {
      harness.port.announceBound(document);
    }
    await harness.coordinator.whenIdle();
    harness.disk.write("C:\\bulk\\file7.txt", "changed externally");

    harness.coordinator.validateAllOnWindowFocus();
    await harness.coordinator.whenIdle();

    expect(harness.disk.readCount()).toBe(1);
    expect(harness.port.documents.get(documents[7].id)!.buffer).toBe(
      "changed externally",
    );
    expect(harness.port.documents.get(documents[8].id)!.buffer).toBe(
      "contents 8",
    );
  });

  it("does no periodic work at all while nothing happens (SC-008)", async () => {
    const harness = await createHarness();
    for (let index = 0; index < 50; index += 1) {
      const path = `C:\\bulk\\file${index}.txt`;
      harness.disk.write(path, `contents ${index}`);
      harness.port.announceBound(harness.port.addBound(path, `contents ${index}`));
    }
    await harness.coordinator.whenIdle();
    const inspectionsBefore = harness.disk.inspections.length;
    const schedulesBefore = harness.scheduler.scheduleCount;

    // An idle interval: no payload, no trigger, no timer. The design has no
    // polling loop at all, which is exactly what "zero periodic full-content
    // reads" requires.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length).toBe(inspectionsBefore);
    expect(harness.disk.readCount()).toBe(0);
    expect(harness.scheduler.scheduleCount).toBe(schedulesBefore);
    expect(harness.scheduler.pendingCount()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Module boundaries                                                          */
/* -------------------------------------------------------------------------- */

describe("005 module boundaries (T051, T056, FR-040)", () => {
  /**
   * The modules 005 adds, none of which may reach the Workspace/Explorer domain.
   *
   * The watcher foundation is meant to be reusable by 006, and 006 brings its own
   * Workspace consumer; a dependency in either direction here would make the two
   * features inseparable. `documentManager.ts` is deliberately not in this list,
   * because its existing 003 path-containment helper predates 005.
   */
  const EXTERNAL_CHANGE_MODULES: Array<[string, string]> = [
    ["filesystemWatcher.ts", filesystemWatcherSource],
    ["watchEventNormalizer.ts", watchEventNormalizerSource],
    ["diskValidation.ts", diskValidationSource],
    ["internalFsOperationGuard.ts", internalFsOperationGuardSource],
    ["openedDocumentWatchCoordinator.ts", coordinatorSource],
  ];

  it.each(EXTERNAL_CHANGE_MODULES)(
    "%s imports no Explorer or Workspace module",
    (_name, source) => {
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
        (match) => match[1],
      );

      expect(specifiers.length).toBeGreaterThan(0);
      expect(
        specifiers.filter(
          (specifier) =>
            specifier.includes("/explorer/") || specifier.includes("/workspace/"),
        ),
      ).toEqual([]);
    },
  );

  it("subscribes non-recursively, so 005 starts no Workspace root watch (FR-006, T056)", async () => {
    const harness = await createHarness();
    await boundDocument(harness, "D:\\outside\\workspace\\a.txt", "alpha");

    expect(harness.watcher.started).toEqual([
      { path: "D:\\outside\\workspace\\a.txt", scope: "nonRecursive" },
    ]);
  });
  it("keeps watching after a Strict Mode unmount/remount (start, dispose, start)", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");

    // What React Strict Mode does in the desktop shell: run the effect, clean it
    // up, then run it again. A consumer that stayed disposed after the cleanup
    // left the whole application without any watching, which is exactly why this
    // is pinned here.
    await harness.coordinator.dispose();
    await harness.coordinator.start();
    await harness.coordinator.whenIdle();

    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);

    harness.disk.write("C:\\work\\a.txt", "changed externally");
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed externally",
    );
    expect(harness.port.documents.get(document.id)!.externalState).toBe("normal");
  });

  it("retries a subscription that could not be established (unwatchable path)", async () => {
    const harness = await createHarness();
    harness.disk.write("C:\\work\\a.txt", "alpha");
    const document = harness.port.addBound("C:\\work\\a.txt", "alpha");
    harness.watcher.failNextSubscribe = true;

    harness.port.announceBound(document);
    await harness.coordinator.whenIdle();
    expect(harness.coordinator.activeSubscriptionCount()).toBe(0);

    // A later cheap trigger heals the channel instead of leaving this document
    // permanently unwatched.
    harness.coordinator.validateAllOnWindowFocus();
    await harness.coordinator.whenIdle();

    expect(harness.coordinator.activeSubscriptionCount()).toBe(1);
    harness.disk.write("C:\\work\\a.txt", "changed externally");
    harness.watcher.emitChange("C:\\work\\a.txt", "changed");
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed externally",
    );
  });  it("revalidates an already-bound document after a restart", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");

    // The change happens while the consumer is not listening at all.
    await harness.coordinator.dispose();
    harness.disk.write("C:\\work\\a.txt", "changed while unlistened");
    await harness.coordinator.start();
    await harness.coordinator.whenIdle();

    harness.port.activate(document.id);
    await harness.coordinator.whenIdle();

    expect(harness.port.documents.get(document.id)!.buffer).toBe(
      "changed while unlistened",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Shared watcher channel: 006 invalidations and relocations (FR-010, FR-061)  */
/* -------------------------------------------------------------------------- */

describe("OpenedDocumentWatchCoordinator shared-channel scoping (006)", () => {
  it("ignores a recursive Workspace invalidation that concerns no open document", async () => {
    const harness = await createHarness();
    await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const inspectionsBefore = harness.disk.inspections.length;

    // 006's Workspace root lost completeness. No document interest is served by
    // that directory, so 005 must not revalidate anything for it.
    harness.watcher.emitRaw({
      type: "invalidated",
      scope: "recursive",
      watchedPath: "D:\\project",
      reason: "watcher overflow",
    });
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length).toBe(inspectionsBefore);
  });

  it("accepts a recursive invalidation for a directory it actually watches", async () => {
    const harness = await createHarness();
    await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const inspectionsBefore = harness.disk.inspections.length;

    // The recursive notice names the same directory this document's
    // non-recursive interest is served by, so its completeness matters here.
    harness.watcher.emitRaw({
      type: "invalidated",
      scope: "recursive",
      watchedPath: "C:\\work",
      reason: "watcher overflow",
    });
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length).toBe(inspectionsBefore + 1);
  });

  it("still revalidates on its own non-recursive invalidation", async () => {
    const harness = await createHarness();
    await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    const inspectionsBefore = harness.disk.inspections.length;

    harness.watcher.emitRaw({
      type: "invalidated",
      scope: "nonRecursive",
      watchedPath: "C:\\work",
      reason: "watcher overflow",
    });
    harness.scheduler.fire();
    await harness.coordinator.whenIdle();

    expect(harness.disk.inspections.length).toBe(inspectionsBefore + 1);
  });
});

describe("OpenedDocumentWatchCoordinator post-relocation validation (006)", () => {
  it("forces a content read after a confirmed external relocation", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");

    // The rebind adopted the destination's *current* metadata, so a cheap
    // revision comparison would call this "unchanged" even though the move
    // rewrote the content (plan §11). Only a forced read can tell.
    const destination = "C:\\work\\b.txt";
    harness.disk.write(destination, "alpha!");
    harness.disk.setRevision(destination, {
      size: 6,
      modifiedTimeMillis: 0,
    });
    document.revision = { size: 6, modifiedTimeMillis: 0 };
    harness.disk.remove("C:\\work\\a.txt");
    const readsBefore = harness.disk.readCount();

    harness.port.announceRebound(document, destination, "external-relocation");
    await harness.coordinator.whenIdle();

    expect(harness.disk.readCount()).toBe(readsBefore + 1);
    const bound = harness.port.documents.get(document.id)!;
    expect(bound.buffer).toBe("alpha!");
    expect(bound.baseline).toBe("alpha!");
    expect(bound.externalState).toBe("normal");
  });

  it("keeps a dirty buffer and reports a conflict when the new target diverged", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    document.dirty = true;
    document.buffer = "alpha edited";

    const destination = "C:\\work\\b.txt";
    harness.disk.write(destination, "alpha!");
    harness.disk.setRevision(destination, {
      size: 6,
      modifiedTimeMillis: 0,
    });
    document.revision = { size: 6, modifiedTimeMillis: 0 };
    harness.disk.remove("C:\\work\\a.txt");

    harness.port.announceRebound(document, destination, "external-relocation");
    await harness.coordinator.whenIdle();

    // FR-061: relocation may not clear a real content conflict, and it never
    // replaces the buffer the user is editing.
    const bound = harness.port.documents.get(document.id)!;
    expect(bound.externalState).toBe("modified");
    expect(bound.buffer).toBe("alpha edited");
    expect(bound.dirty).toBe(true);
  });

  it("keeps the cheap path for an ordinary Save As rebound", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");

    const destination = "C:\\work\\b.txt";
    harness.disk.write(destination, "alpha");
    harness.disk.setRevision(destination, { size: 5, modifiedTimeMillis: 0 });
    document.revision = { size: 5, modifiedTimeMillis: 0 };
    harness.disk.remove("C:\\work\\a.txt");
    const readsBefore = harness.disk.readCount();

    harness.port.announceRebound(document, destination);
    await harness.coordinator.whenIdle();

    // Without the external-relocation cause the matching revision is still
    // trusted, so an ordinary path change performs no content read (SC-008).
    expect(harness.disk.readCount()).toBe(readsBefore);
  });
});

describe("OpenedDocumentWatchCoordinator case-only relocation (FR-046, FR-061)", () => {
  it("forces validation when a case-only move changed the content", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");

    // Windows: the spelling changed, the comparison key did not, and the rebind
    // adopted the destination's own metadata — so a revision comparison would
    // wrongly call this "unchanged" (plan §11).
    const destination = "C:\\work\\A.TXT";
    const revision = { size: 6, modifiedTimeMillis: 0 };
    harness.disk.remove("C:\\work\\a.txt");
    harness.disk.write(destination, "alpha!");
    harness.disk.setRevision(destination, revision);
    document.revision = revision;
    const readsBefore = harness.disk.readCount();

    harness.port.announceRebound(document, destination, "external-relocation");
    await harness.coordinator.whenIdle();

    expect(harness.disk.readCount()).toBe(readsBefore + 1);
    const bound = harness.port.documents.get(document.id)!;
    expect(bound.path).toBe(destination);
    expect(bound.buffer).toBe("alpha!");
    expect(bound.externalState).toBe("normal");
  });

  it("keeps a dirty buffer and reports modified when the case-only target diverged", async () => {
    const harness = await createHarness();
    const document = await boundDocument(harness, "C:\\work\\a.txt", "alpha");
    document.dirty = true;
    document.buffer = "alpha edited";

    const destination = "C:\\work\\A.TXT";
    const revision = { size: 6, modifiedTimeMillis: 0 };
    harness.disk.remove("C:\\work\\a.txt");
    harness.disk.write(destination, "alpha!");
    harness.disk.setRevision(destination, revision);
    document.revision = revision;

    harness.port.announceRebound(document, destination, "external-relocation");
    await harness.coordinator.whenIdle();

    const bound = harness.port.documents.get(document.id)!;
    expect(bound.externalState).toBe("modified");
    expect(bound.buffer).toBe("alpha edited");
    expect(bound.dirty).toBe(true);
  });
});
