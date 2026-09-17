/**
 * Multi-document lifecycle owner.
 *
 * `DocumentManager` owns the ordered set of open documents, which one is
 * active, how `UntitledN` numbers are allocated, and — in later phases — file
 * identity ownership, save generations and close coordination. Every operation
 * is addressed to an explicit `DocumentId`, so an asynchronous completion can
 * never mutate whichever document happens to be active when it finishes.
 *
 * Two boundaries drive the design:
 *
 * 1. CodeMirror owns the live text. Sessions hold `EditorState` references, and
 *    React only ever sees lightweight `DocumentManagerSnapshot` metadata.
 * 2. React is not notified for every editor transaction. A snapshot is emitted
 *    only when a Tab-visible field changes.
 */

import type { EditorState, Text } from "@codemirror/state";

import { createEditorState } from "../../editor/editorConfig";
import type { EditorHandle } from "../../editor/editorHandle";
import type { FileDialogService } from "../../services/fileDialogs";
import {
  toFileCommandError,
  type FileCommandError,
  type FileService,
  type OpenTextFileResult,
  type ResolvedPathIdentity,
  type WriteTextFileRequest,
} from "../../services/fileService";
import {
  NEW_DOCUMENT_FORMAT,
  createDefaultViewState,
  createDocumentId,
  displayNameForPath,
  untitledDisplayName,
  type DocumentId,
  type DocumentManagerSnapshot,
  type DocumentSession,
  type TabSnapshot,
} from "./documentSession";

/** Receives every Tab-visible metadata change. */
export type DocumentManagerListener = (
  snapshot: DocumentManagerSnapshot,
) => void;

/**
 * Optional SC-005 Tab-activation timing marks.
 *
 * Only user Tab selections are measured; internal activations (open, New,
 * drag/drop) are not, because they are not the interaction under test.
 */
export interface ActivationRecorder {
  /** Called when the user selects a Tab, before the switch starts. */
  begin(documentId: DocumentId): void;
  /** Called once the target state is bound and focused. */
  complete(): void;
}

export interface DocumentManagerDeps {
  /** The shared editor; the only owner of live document state. */
  editor: EditorHandle;
  /** File IPC used by open/save/save-as. */
  fileService: FileService;
  /** Native dialogs used by open/save-as/unsaved prompts. */
  dialogs: FileDialogService;
  /** Optional activation timing recorder. */
  activationBenchmark?: ActivationRecorder | null;
}

/** Outcome of an open request. */
export type OpenPathResult =
  | { status: "opened"; documentId: DocumentId }
  | { status: "activated-existing"; documentId: DocumentId }
  | { status: "ignored-directory" }
  | { status: "cancelled" }
  | { status: "failed"; error: FileCommandError };

/** Options for `openPath`. */
export interface OpenPathOptions {
  /**
   * Treat a directory target as "nothing to do" instead of a failure, which is
   * what a dropped batch needs.
   */
  ignoreDirectories?: boolean;
}

/** Outcome of a lifecycle command. */
export type CommandResult =
  | { status: "success" }
  | { status: "cancelled" }
  | { status: "failed"; error: FileCommandError };

/** Outcome of closing one Tab. */
export type CloseDocumentResult =
  | { status: "closed" }
  | { status: "cancelled" }
  | { status: "failed"; error: FileCommandError };

/** One in-flight Save As reservation for a destination comparison key. */
interface PathClaim {
  documentId: DocumentId;
  /** The save generation that owns the reservation. */
  generation: number;
}

export class DocumentManager {
  private readonly editor: EditorHandle;
  private readonly fileService: FileService;
  private readonly dialogs: FileDialogService;
  private readonly activationBenchmark: ActivationRecorder | null;

  private readonly orderedIds: DocumentId[] = [];
  private readonly sessions = new Map<DocumentId, DocumentSession>();
  private readonly listeners = new Set<DocumentManagerListener>();

  /** comparisonKey -> owning document. A key is owned by at most one session. */
  private readonly openPathIndex = new Map<string, DocumentId>();
  /**
   * comparisonKey -> the Save As operation reserving that destination.
   *
   * The reservation records the *generation* that owns it, because one document
   * may renew the same destination while an older operation is still in flight.
   * A stale completion must never release the reservation its newer successor
   * is still relying on.
   */
  private readonly pendingPathClaims = new Map<string, PathClaim>();
  /**
   * comparisonKey -> the open request currently resolving it.
   *
   * Two overlapping requests for one destination must produce one session, not
   * two, so the second waits for the first instead of starting its own read.
   */
  private readonly pendingOpens = new Map<string, Promise<OpenPathResult>>();
  /**
   * Per-destination write chains, keyed by comparison key.
   *
   * Two overlapping writes to the same file must land in the order they were
   * issued, otherwise an earlier — and by then stale — snapshot can win the
   * race and leave the file holding content the user already replaced. The key
   * is the resolved comparison key, so equivalent spellings of one destination
   * share a chain.
   */
  private readonly writeChains = new Map<string, Promise<void>>();

  private activeDocumentId: DocumentId;
  private nextUntitledNumber = 1;

  constructor(deps: DocumentManagerDeps) {
    this.editor = deps.editor;
    this.fileService = deps.fileService;
    this.dialogs = deps.dialogs;
    this.activationBenchmark = deps.activationBenchmark ?? null;

    // A fresh application session always starts in normal editing mode with one
    // clean document. The editor is not touched here: the initial binding is
    // handed to the `Editor` component when it mounts.
    const first = this.appendUntitledSession();
    this.activeDocumentId = first.id;
  }

  /* ---------------------------------------------------------------------- */
  /* Read surface                                                           */
  /* ---------------------------------------------------------------------- */

  /** The session for `id`, or `undefined` once it has been closed. */
  getSession(id: DocumentId): DocumentSession | undefined {
    return this.sessions.get(id);
  }

  /** The session the shared view is currently showing. */
  getActiveSession(): DocumentSession {
    return this.requireSession(this.activeDocumentId);
  }

  /** Every open session, in Tab order. */
  listSessions(): readonly DocumentSession[] {
    return this.orderedIds.map((id) => this.requireSession(id));
  }

  /** The lightweight projection React renders. */
  getSnapshot(): DocumentManagerSnapshot {
    return {
      activeDocumentId: this.activeDocumentId,
      tabs: this.orderedIds.map((id) =>
        this.toTabSnapshot(this.requireSession(id)),
      ),
    };
  }

  /** Subscribes to metadata changes; returns the unsubscribe function. */
  subscribe(listener: DocumentManagerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether any open document currently differs from its saved baseline. */
  hasDirtyDocuments(): boolean {
    return this.listSessions().some((session) => session.dirty);
  }

  /* ---------------------------------------------------------------------- */
  /* Creation and activation                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates, appends and activates a clean untitled document.
   *
   * `UntitledN` numbers come from a counter that only ever increases, so a
   * number is never reused after its document is saved or closed.
   */
  createUntitled(): DocumentId {
    const session = this.appendUntitledSession();
    this.activateDocument(session.id);
    return session.id;
  }

  /**
   * Makes `id` the active document.
   *
   * The outgoing document keeps its reading position, the target state is
   * installed under the target identity, and the restored position is applied
   * afterwards. The shared view itself is never recreated.
   */
  activateDocument(id: DocumentId): void {
    const target = this.sessions.get(id);
    if (target === undefined) {
      return;
    }

    if (id === this.activeDocumentId) {
      if (this.editor.isReady()) {
        this.editor.focus();
      }
      return;
    }

    const outgoing = this.sessions.get(this.activeDocumentId);
    if (outgoing !== undefined && this.editor.isReady()) {
      outgoing.viewState = this.editor.captureViewState();
    }

    this.activeDocumentId = id;

    if (this.editor.isReady()) {
      this.editor.setState(id, target.editorState);
      this.editor.restoreViewState(target.viewState);
    }

    this.emitSnapshot();

    if (this.editor.isReady()) {
      this.editor.focus();
    }
  }

  /**
   * Activates a Tab because the *user* selected it.
   *
   * Identical to `activateDocument` apart from the SC-005 timing marks, which
   * measure the interaction a user performs and never internal activations
   * (open, New, drag/drop).
   */
  selectDocument(id: DocumentId): void {
    this.activationBenchmark?.begin(id);
    this.activateDocument(id);
    this.activationBenchmark?.complete();
  }

  /* ---------------------------------------------------------------------- */
  /* Opening                                                                */
  /* ---------------------------------------------------------------------- */

  /** Asks for a file and opens it. */
  async openFromDialog(): Promise<OpenPathResult> {
    const path = await this.dialogs.pickOpenPath();
    if (path === null) {
      return { status: "cancelled" };
    }

    return this.openPath(path);
  }

  /**
   * Opens `path` as a document.
   *
   * Identity is resolved first so an already-open file is activated without
   * being read again. A session is registered only after the read and decode
   * succeed, which is what keeps a failed open from leaving a half-initialized
   * Tab behind.
   */
  async openPath(
    path: string,
    options: OpenPathOptions = {},
  ): Promise<OpenPathResult> {
    let identity: ResolvedPathIdentity;
    try {
      identity = await this.fileService.inspectFilePath(path, false);
    } catch (error) {
      return {
        status: "failed",
        error: await this.reportError(error, "path_resolution"),
      };
    }

    const existing = this.openPathIndex.get(identity.comparisonKey);
    if (existing !== undefined) {
      this.activateDocument(existing);
      return { status: "activated-existing", documentId: existing };
    }

    if (identity.kind === "directory") {
      if (options.ignoreDirectories === true) {
        return { status: "ignored-directory" };
      }

      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `${path} is a folder, not a file.`,
        ),
      };
    }

    const key = identity.comparisonKey;

    // An open request for this destination is already resolving it. Waiting for
    // it — instead of starting a second read — is what keeps one comparison key
    // from ever being registered by two sessions.
    const inFlight = this.pendingOpens.get(key);
    if (inFlight !== undefined) {
      const result = await inFlight;
      if (result.status === "opened") {
        this.activateDocument(result.documentId);
        return { status: "activated-existing", documentId: result.documentId };
      }
      // A failed or ignored first request is this request's answer too.
      return result;
    }

    // The reservation is installed before the first read starts, so an
    // overlapping request can never slip past it.
    const open = this.registerOpenedSession(path, identity);
    this.pendingOpens.set(key, open);
    try {
      return await open;
    } finally {
      if (this.pendingOpens.get(key) === open) {
        this.pendingOpens.delete(key);
      }
    }
  }

  /**
   * Reads and decodes an inspected path, then registers and activates the
   * session it produces.
   *
   * The session exists only after the read succeeded, so a failed or cancelled
   * open leaves the Tab list exactly as it was.
   */
  private async registerOpenedSession(
    path: string,
    identity: ResolvedPathIdentity,
  ): Promise<OpenPathResult> {
    let opened: OpenTextFileResult;
    try {
      opened = await this.fileService.readTextFile(path);
    } catch (error) {
      return {
        status: "failed",
        error: await this.reportError(error, "io_read"),
      };
    }

    // Only now may a session exist.
    const state = createEditorState(opened.text, this.editor.extensions);
    const session: DocumentSession = {
      id: createDocumentId(),
      path,
      pathIdentity: identity,
      displayName: displayNameForPath(path),
      format: opened.format,
      dirty: false,
      savedBaseline: state.doc,
      editorState: state,
      viewState: createDefaultViewState(),
      latestSaveGeneration: 0,
    };

    this.orderedIds.push(session.id);
    this.sessions.set(session.id, session);
    this.openPathIndex.set(identity.comparisonKey, session.id);
    this.activateDocument(session.id);

    return { status: "opened", documentId: session.id };
  }

  /* ---------------------------------------------------------------------- */
  /* Saving                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Saves `id` to its current destination.
   *
   * The document id, its text snapshot, its format and a fresh save generation
   * are all captured before the write starts. A clean same-path Save is a
   * deliberate no-op: Sorakada does not retain per-line EOL provenance, so
   * rewriting an unedited Mixed file would normalize bytes the user never
   * touched.
   */
  async saveDocument(id: DocumentId): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return { status: "success" };
    }
    if (session.path === null) {
      return this.saveDocumentAs(id);
    }
    if (!session.dirty) {
      return { status: "success" };
    }

    const targetPath = session.path;
    const generation = session.latestSaveGeneration + 1;
    session.latestSaveGeneration = generation;
    const snapshot = session.editorState.doc;
    const format = session.format;

    try {
      await this.enqueueWrite(
        session.pathIdentity?.comparisonKey ?? targetPath,
        {
          path: targetPath,
          text: snapshot.toString(),
          bom: format.bom,
          lineEnding: format.preferredLineEnding,
        },
      );
    } catch (error) {
      return {
        status: "failed",
        error: await this.reportError(error, "io_write"),
      };
    }

    return this.commitSave(id, generation, snapshot, null);
  }

  /**
   * Writes `id` to a newly chosen destination.
   *
   * The target's comparison key is resolved and reserved before anything is
   * written, so two documents can never end up owning one destination — not
   * even a destination that does not exist yet.
   */
  async saveDocumentAs(id: DocumentId): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return { status: "success" };
    }

    const target = await this.dialogs.pickSavePath(session.path);
    if (target === null) {
      return { status: "cancelled" };
    }

    let candidate: ResolvedPathIdentity;
    try {
      candidate = await this.fileService.inspectFilePath(target, true);
    } catch (error) {
      return {
        status: "failed",
        error: await this.reportError(error, "path_resolution"),
      };
    }

    const key = candidate.comparisonKey;
    const owner = this.openPathIndex.get(key);
    if (owner !== undefined && owner !== id) {
      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `${target} is already open in another tab.`,
        ),
      };
    }

    const claimer = this.pendingPathClaims.get(key);
    if (claimer !== undefined && claimer.documentId !== id) {
      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `${target} is already being saved by another tab.`,
        ),
      };
    }

    const generation = session.latestSaveGeneration + 1;
    session.latestSaveGeneration = generation;
    // The reservation is generation-scoped: renewing the same destination
    // replaces the claim, and the older operation may no longer release it.
    this.pendingPathClaims.set(key, { documentId: id, generation });

    const snapshot = session.editorState.doc;
    const format = session.format;

    try {
      await this.enqueueWrite(key, {
        path: target,
        text: snapshot.toString(),
        bom: format.bom,
        lineEnding: format.preferredLineEnding,
      });
    } catch (error) {
      this.releaseClaim(key, id, generation);
      return {
        status: "failed",
        error: await this.reportError(error, "io_write"),
      };
    }

    const current = this.sessions.get(id);
    if (current === undefined || current.latestSaveGeneration !== generation) {
      // The bytes were written because the user asked for them, but this
      // completion is no longer the document's newest intent, so it must not
      // move the path or the baseline — nor release a reservation that a newer
      // operation now owns.
      this.releaseClaim(key, id, generation);
      return { status: "success" };
    }

    let adopted: ResolvedPathIdentity = candidate;
    try {
      adopted = await this.fileService.inspectFilePath(target, false);
    } catch {
      // The write succeeded, so the candidate identity still describes the
      // destination; a failed refresh must not undo a successful save.
      adopted = candidate;
    }

    const result = this.commitSave(id, generation, snapshot, adopted);
    // A relevant completion converted the reservation into ownership; an
    // irrelevant one gives the destination back, but only its own reservation.
    this.releaseClaim(key, id, generation);
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* Closing                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Closes `id`.
   *
   * A dirty document keeps the existing Save / Don't Save / Cancel semantics,
   * and an inactive document is never activated just to be saved or closed.
   */
  async closeDocument(id: DocumentId): Promise<CloseDocumentResult> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return { status: "closed" };
    }

    if (session.dirty) {
      const choice = await this.dialogs.confirmUnsavedChanges(
        session.displayName,
      );

      if (choice === "cancel") {
        return { status: "cancelled" };
      }
      if (choice === "save") {
        const saved = await this.saveDocument(id);
        if (saved.status === "failed") {
          return { status: "failed", error: saved.error };
        }
        if (saved.status === "cancelled") {
          return { status: "cancelled" };
        }
      }
    }

    if (!this.sessions.has(id)) {
      return { status: "closed" };
    }

    return this.removeSession(id);
  }

  /**
   * The close-window guard.
   *
   * It walks a stable snapshot of the Tab order, prompts only dirty documents,
   * and returns `false` as soon as one document is cancelled or fails to save.
   * It never removes a Tab and never creates a replacement `UntitledN`: the
   * caller destroys the window instead.
   */
  async prepareCloseAll(): Promise<boolean> {
    const ids = [...this.orderedIds];

    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session === undefined || !session.dirty) {
        continue;
      }

      const choice = await this.dialogs.confirmUnsavedChanges(
        session.displayName,
      );
      if (choice === "cancel") {
        return false;
      }
      if (choice === "save") {
        const saved = await this.saveDocument(id);
        if (saved.status !== "success") {
          return false;
        }
      }
    }

    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Editor update ingress                                                  */
  /* ---------------------------------------------------------------------- */
  /**
   * Records the newest editor state for the document the bridge reported.
   *
   * The session is always found through the callback's own document id, never
   * through the active Tab, so an update that arrives during a switch cannot be
   * credited to the wrong document.
   */
  handleEditorStateUpdate(
    id: DocumentId,
    state: EditorState,
    docChanged: boolean,
  ): void {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return;
    }

    session.editorState = state;

    if (!docChanged) {
      return;
    }

    const dirty = !state.doc.eq(session.savedBaseline);
    if (dirty !== session.dirty) {
      session.dirty = dirty;
      this.emitSnapshot();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Applies a completed write to its session.
   *
   * This is the only place a saved baseline may advance. The completion is
   * matched by document id *and* save generation, so a write that finished
   * after the document was closed, or after a newer intent replaced it, can
   * never mutate a surviving session.
   */
  private commitSave(
    id: DocumentId,
    generation: number,
    snapshot: Text,
    adoption: ResolvedPathIdentity | null,
  ): CommandResult {
    const session = this.sessions.get(id);
    if (session === undefined || session.latestSaveGeneration !== generation) {
      return { status: "success" };
    }

    // A foreign owner is never overwritten; `adoptPath` reports whether the
    // path adoption actually happened.
    const adopted =
      adoption !== null ? this.adoptPath(session, adoption, generation) : false;

    session.savedBaseline = snapshot;
    const dirty = !session.editorState.doc.eq(snapshot);
    const dirtyChanged = dirty !== session.dirty;
    session.dirty = dirty;

    if (adopted || dirtyChanged) {
      this.emitSnapshot();
    }

    return { status: "success" };
  }

  /**
   * Moves path ownership to `session` after a successful Save As.
   *
   * Returns `false` when another live session already owns the destination, in
   * which case nothing is adopted: one comparison key belongs to at most one
   * live session, and the existing owner wins.
   */
  private adoptPath(
    session: DocumentSession,
    identity: ResolvedPathIdentity,
    generation: number,
  ): boolean {
    const owner = this.openPathIndex.get(identity.comparisonKey);
    if (owner !== undefined && owner !== session.id) {
      return false;
    }

    const previousKey = session.pathIdentity?.comparisonKey;
    if (previousKey !== undefined && previousKey !== identity.comparisonKey) {
      if (this.openPathIndex.get(previousKey) === session.id) {
        this.openPathIndex.delete(previousKey);
      }
    }

    // This operation's reservation becomes regular ownership.
    this.releaseClaim(identity.comparisonKey, session.id, generation);
    this.openPathIndex.set(identity.comparisonKey, session.id);

    session.path = identity.requestedPath;
    session.pathIdentity = identity;
    session.displayName = displayNameForPath(identity.requestedPath);

    return true;
  }

  /**
   * Serializes writes per destination comparison key so they hit the disk in
   * issue order, even when two equivalent spellings name the same file.
   */
  private enqueueWrite(
    comparisonKey: string,
    request: WriteTextFileRequest,
  ): Promise<void> {
    const previous = this.writeChains.get(comparisonKey);
    // With nothing in flight for this destination the write starts immediately;
    // only an overlapping write has to wait its turn.
    const write =
      previous === undefined
        ? this.fileService.writeTextFile(request)
        : previous
            .catch(() => undefined)
            .then(() => this.fileService.writeTextFile(request));

    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(comparisonKey, settled);
    void settled.then(() => {
      if (this.writeChains.get(comparisonKey) === settled) {
        this.writeChains.delete(comparisonKey);
      }
    });

    return write;
  }

  /**
   * Gives a Save As reservation back.
   *
   * Only the operation that owns the reservation may release it: a stale
   * completion must never delete the claim a newer Save As renewed.
   */
  private releaseClaim(
    key: string,
    id: DocumentId,
    generation: number,
  ): void {
    const claim = this.pendingPathClaims.get(key);
    if (
      claim !== undefined &&
      claim.documentId === id &&
      claim.generation === generation
    ) {
      this.pendingPathClaims.delete(key);
    }
  }

  /**
   * Removes a document and applies the normal neighbour rule when it was the
   * active one. Only a successful close may call this — never window exit.
   */
  private removeSession(id: DocumentId): CloseDocumentResult {
    const index = this.orderedIds.indexOf(id);
    const wasActive = this.activeDocumentId === id;

    this.releaseOwnership(id);
    this.sessions.delete(id);
    if (index !== -1) {
      this.orderedIds.splice(index, 1);
    }

    if (!wasActive) {
      this.emitSnapshot();
      return { status: "closed" };
    }

    if (this.orderedIds.length === 0) {
      // Normal editing mode always contains a document.
      this.createUntitled();
      return { status: "closed" };
    }

    // Closest remaining Tab on the left, otherwise the new first Tab.
    this.activateDocument(
      index > 0 ? this.orderedIds[index - 1] : this.orderedIds[0],
    );
    return { status: "closed" };
  }

  /** Frees every comparison key a document owned or reserved. */
  private releaseOwnership(id: DocumentId): void {
    const key = this.sessions.get(id)?.pathIdentity?.comparisonKey;
    if (key !== undefined && this.openPathIndex.get(key) === id) {
      this.openPathIndex.delete(key);
    }

    for (const [claimedKey, claim] of this.pendingPathClaims) {
      if (claim.documentId === id) {
        this.pendingPathClaims.delete(claimedKey);
      }
    }
  }

  /** Appends a clean untitled session without activating it. */
  private appendUntitledSession(): DocumentSession {
    const state = createEditorState("", this.editor.extensions);
    const session: DocumentSession = {
      id: createDocumentId(),
      path: null,
      pathIdentity: null,
      displayName: untitledDisplayName(this.nextUntitledNumber),
      format: { ...NEW_DOCUMENT_FORMAT },
      dirty: false,
      savedBaseline: state.doc,
      editorState: state,
      viewState: createDefaultViewState(),
      latestSaveGeneration: 0,
    };

    this.nextUntitledNumber += 1;
    this.orderedIds.push(session.id);
    this.sessions.set(session.id, session);

    return session;
  }

  private toTabSnapshot(session: DocumentSession): TabSnapshot {
    return {
      id: session.id,
      displayName: session.displayName,
      path: session.path,
      dirty: session.dirty,
      active: session.id === this.activeDocumentId,
    };
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private requireSession(id: DocumentId): DocumentSession {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new Error(`Document "${id}" is not open.`);
    }
    return session;
  }

  /** Reports a failure to the user and returns the error the caller receives. */
  private async reportError(
    error: unknown,
    fallbackCode: FileCommandError["code"],
  ): Promise<FileCommandError> {
    const fileError = toFileCommandError(error, fallbackCode);
    await this.dialogs.showError(fileError.message);
    return fileError;
  }

  /** Reports a failure the manager itself detected, such as a folder target. */
  private async reportMessage(
    code: FileCommandError["code"],
    message: string,
  ): Promise<FileCommandError> {
    const fileError: FileCommandError = { code, message };
    await this.dialogs.showError(message);
    return fileError;
  }
}
