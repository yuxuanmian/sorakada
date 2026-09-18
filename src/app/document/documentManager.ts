/**
 * Multi-document lifecycle owner.
 *
 * `DocumentManager` owns the ordered set of open documents, which one is
 * active, how `UntitledN` numbers are allocated, file identity ownership, save
 * generations, path-operation coordination and close negotiation. Every
 * operation is addressed to an explicit `DocumentId`, so an asynchronous
 * completion can never mutate whichever document happens to be active when it
 * finishes.
 *
 * Two boundaries drive the design:
 *
 * 1. CodeMirror owns the live text. Sessions hold `EditorState` references, and
 *    React only ever sees lightweight `DocumentManagerSnapshot` metadata.
 * 2. React is not notified for every editor transaction. A snapshot is emitted
 *    only when a Tab-visible field changes.
 *
 * 003 makes zero documents a valid steady state (`activeDocumentId` is
 * nullable) and lets Explorer path mutations reserve destinations through the
 * same mechanism Open and Save As already use, so one canonical destination can
 * never be owned by two live sessions.
 */

import type { EditorState, Text } from "@codemirror/state";

import { createEditorState } from "../../editor/editorConfig";
import type { EditorHandle } from "../../editor/editorHandle";
import type { FileDialogService } from "../../services/fileDialogs";
import {
  isFileCommandError,
  toFileCommandError,
  type FileCommandError,
  type FileService,
  type OpenTextFileResult,
  type ResolvedPathIdentity,
  type WriteTextFileRequest,
} from "../../services/fileService";
import {
  isWithinDirectory,
  joinPath,
  relativeWithinDirectory,
} from "../workspace/workContext";
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
  /** Settles when the reservation is released, so an Open can wait for it. */
  settled: Promise<void>;
  settle(): void;
}

/**
 * A filesystem path mutation reserved against overlapping document work.
 *
 * Rename and Delete reserve through this so an in-flight Open, Save As or write
 * can neither register a stale session for the old path nor restore it after the
 * disk operation committed (FR-100, FR-103).
 */
export interface PathMutationReservation {
  /** Releases the reservation. Safe to call more than once. */
  release(): void;
}

/** What a filesystem path mutation needs coordinated. */
export interface PathMutationRequest {
  /**
   * Canonical comparison key of the path being mutated away from. A directory
   * mutation also covers every currently open document below it.
   */
  sourceKey: string;
  /**
   * Canonical comparison key the mutation will create, when it creates one.
   * Rename passes its destination; Delete passes nothing.
   */
  destinationKey?: string;
}

/** Outcome of reserving a path mutation. */
export type PathMutationResult =
  | { status: "reserved"; reservation: PathMutationReservation }
  | { status: "failed"; error: FileCommandError };

/** A path mutation that has been reserved and not yet released. */
interface PathMutationClaim {
  id: number;
  sourceKey: string;
  destinationKey: string | null;
  /** Settles when this mutation is released. */
  settled: Promise<void>;
  release(): void;
}

/** The identity bookkeeping a committed rename needs. */
export interface CommittedPathRename {
  /** Canonical identity of the entry *before* the rename. */
  sourceIdentity: { canonicalPath: string; comparisonKey: string };
  /** User-facing path of the entry after the rename. */
  newPath: string;
  /** Freshly resolved identity of the entry after the rename. */
  newIdentity: ResolvedPathIdentity;
  /**
   * The sessions the caller already identified as affected.
   *
   * An Explorer rename decides containment with the canonical
   * `resolve_workspace_relation` command while it holds the path reservation, so
   * it passes the resulting ids here and this method does not have to re-decide
   * which documents are below the renamed entry. Omitted by callers with no
   * relation source, in which case containment is derived from the canonical
   * comparison keys instead — the same semantics, just decided locally.
   */
  affectedDocumentIds?: readonly DocumentId[];
}

/**
 * How many times an Open may re-resolve after waiting for a path mutation.
 *
 * A mutation always settles, so this is a safety bound rather than a real retry
 * budget: it exists so a pathological stream of overlapping renames cannot make
 * one Open loop forever.
 */
const MAX_MUTATION_WAITS = 8;

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
  /**
   * Filesystem path mutations that are currently reserved.
   *
   * Rename/Delete appear here so an overlapping Open or Save As sees the
   * destination as taken and the source as busy, instead of racing the disk
   * operation and committing state that contradicts it.
   */
  private readonly pathMutations = new Map<number, PathMutationClaim>();

  /**
   * The active document, or `null` when no document is open.
   *
   * 003 supersedes the 002 invariant that a running application always contains
   * a document: zero documents is a valid steady state and the Empty State is
   * UI only, never a fake session.
   */
  private activeDocumentId: DocumentId | null = null;
  private nextUntitledNumber = 1;
  private nextPathMutationId = 1;

  constructor(deps: DocumentManagerDeps) {
    this.editor = deps.editor;
    this.fileService = deps.fileService;
    this.dialogs = deps.dialogs;
    this.activationBenchmark = deps.activationBenchmark ?? null;

    // A bare launch opens no document at all (FR-013). The first document is
    // created by an explicit New/Open, and the editor is not touched here.
  }

  /* ---------------------------------------------------------------------- */
  /* Read surface                                                           */
  /* ---------------------------------------------------------------------- */

  /** The session for `id`, or `undefined` once it has been closed. */
  getSession(id: DocumentId): DocumentSession | undefined {
    return this.sessions.get(id);
  }

  /** The active document's id, or `null` when no document is open. */
  getActiveDocumentId(): DocumentId | null {
    return this.activeDocumentId;
  }

  /**
   * The session the shared view is currently showing, or `null` when no
   * document is open.
   */
  getActiveSession(): DocumentSession | null {
    if (this.activeDocumentId === null) {
      return null;
    }
    return this.sessions.get(this.activeDocumentId) ?? null;
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
   * afterwards. The shared view itself is never recreated. A null active
   * document is a normal starting point, which is what lets a zero-to-one
   * transition mount the editor without a previous document to capture.
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

    const outgoing =
      this.activeDocumentId === null
        ? undefined
        : this.sessions.get(this.activeDocumentId);
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
    return this.openPathWaitingForMutations(path, options, 0);
  }

  /**
   * `openPath` with the path-mutation handshake.
   *
   * An Open that resolves a path a pending Rename/Delete is about to move must
   * not register a session for the old spelling. Waiting for the mutation to
   * settle and then re-resolving is what keeps a stale completion from creating
   * a second, immediately-wrong session (FR-100, FR-103).
   */
  private async openPathWaitingForMutations(
    path: string,
    options: OpenPathOptions,
    waits: number,
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

    // An in-flight Save As, or a reserved Rename/Delete, owns this destination
    // for now. Waiting for it and then re-resolving is what keeps the two
    // operations from creating duplicate ownership of one canonical path
    // (FR-099, FR-100).
    const pendingWrite = this.pendingPathClaims.get(key);
    const covering = this.mutationCovering(key);
    if (pendingWrite !== undefined || covering !== null) {
      if (waits >= MAX_MUTATION_WAITS) {
        // Falling through here would register a session for a path another
        // operation is still changing, which is exactly the contradiction
        // FR-100/FR-103 forbid, so the Open fails deterministically instead.
        return {
          status: "failed",
          error: await this.reportMessage(
            "path_resolution",
            `${path} is being changed by another operation.`,
          ),
        };
      }

      await (pendingWrite?.settled ?? covering!.settled);
      return this.openPathWaitingForMutations(path, options, waits + 1);
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
    return this.saveDocumentInternal(id, 0);
  }

  private async saveDocumentInternal(
    id: DocumentId,
    waits: number,
  ): Promise<CommandResult> {
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

    // A pending Rename/Delete may be about to move this document's own path, so
    // the write must target wherever the document ends up rather than recreate
    // the old spelling after the disk operation committed.
    const covering = this.mutationCovering(
      session.pathIdentity?.comparisonKey ?? session.path,
    );
    if (covering !== null) {
      if (waits >= MAX_MUTATION_WAITS) {
        // The path is still being changed after the wait budget, so writing to
        // the old spelling would contradict the disk operation (FR-103).
        return {
          status: "failed",
          error: await this.reportMessage(
            "path_resolution",
            `${session.path} is being changed by another operation.`,
          ),
        };
      }

      await covering.settled;
      return this.saveDocumentInternal(id, waits + 1);
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

    const resolved = await this.resolveSaveAsDestination(target);
    if (isFileCommandError(resolved)) {
      return {
        status: "failed",
        error: await this.reportError(resolved, "path_resolution"),
      };
    }
    const candidate = resolved;

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

    // An Open that has already reserved this destination owns the outcome, so
    // the Save As fails before writing instead of racing it into a duplicate
    // session (FR-099, FR-100).
    if (this.pendingOpens.has(key)) {
      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `${target} is already being opened in another tab.`,
        ),
      };
    }

    const mutation = this.mutationCovering(key);
    if (mutation !== null) {
      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `${target} is already being changed by another operation.`,
        ),
      };
    }

    const generation = session.latestSaveGeneration + 1;
    session.latestSaveGeneration = generation;
    // The reservation is generation-scoped: renewing the same destination
    // replaces the claim, and the older operation may no longer release it.
    this.pendingPathClaims.set(key, this.createPathClaim(id, generation));

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

    const result = await this.commitSave(id, generation, snapshot, adopted);
    // A relevant completion converted the reservation into ownership; an
    // irrelevant one gives the destination back, but only its own reservation.
    this.releaseClaim(key, id, generation);
    return result;
  }

  /**
   * Resolves a Save As destination, waiting out a pending path mutation.
   *
   * Returns the error rather than reporting it, so `saveDocumentAs` keeps a
   * single reporting site for every failure.
   */
  private async resolveSaveAsDestination(
    target: string,
  ): Promise<ResolvedPathIdentity | FileCommandError> {
    for (let attempt = 0; attempt <= MAX_MUTATION_WAITS; attempt += 1) {
      let inspected: ResolvedPathIdentity;
      try {
        inspected = await this.fileService.inspectFilePath(target, true);
      } catch (error) {
        return toFileCommandError(error, "path_resolution");
      }

      const covering = this.mutationCovering(inspected.comparisonKey);
      if (covering === null) {
        return inspected;
      }
      if (attempt === MAX_MUTATION_WAITS) {
        return {
          code: "path_resolution",
          message: `${target} is already being changed by another operation.`,
        };
      }

      await covering.settled;
    }

    return {
      code: "path_resolution",
      message: `${target} could not be reserved.`,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Closing                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Closes `id`.
   *
   * A dirty document keeps the existing Save / Don't Save / Cancel semantics,
   * and an inactive document is never activated just to be saved or closed.
   *
   * The loop is the FR-101 guard: a save that completes while newer edits are
   * still arriving leaves the document dirty again, and at that point the close
   * decision is simply not finished — the guard repeats rather than discarding
   * work the user never agreed to lose.
   */
  async closeDocument(id: DocumentId): Promise<CloseDocumentResult> {
    for (;;) {
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
          // Re-check the live session: edits made during the save leave it
          // dirty again and must be re-decided, not thrown away.
          continue;
        }
      }

      if (!this.sessions.has(id)) {
        return { status: "closed" };
      }

      return this.removeSession(id);
    }
  }

  /**
   * The close-window guard.
   *
   * It walks a stable snapshot of the Tab order, prompts only dirty documents,
   * and returns `false` as soon as one document is cancelled or fails to save.
   * Like `closeDocument`, it re-checks each document after a save so an edit
   * that arrived mid-write still has to be decided. It never removes a Tab and
   * never creates a replacement `UntitledN`: the caller destroys the window
   * instead.
   */
  async prepareCloseAll(): Promise<boolean> {
    const ids = [...this.orderedIds];

    for (const id of ids) {
      for (;;) {
        const session = this.sessions.get(id);
        if (session === undefined || !session.dirty) {
          break;
        }

        const choice = await this.dialogs.confirmUnsavedChanges(
          session.displayName,
        );
        if (choice === "cancel") {
          return false;
        }
        if (choice === "dontSave") {
          break;
        }

        const saved = await this.saveDocument(id);
        if (saved.status !== "success") {
          return false;
        }
        // Loop back: a save that did not leave the document clean has not
        // finished deciding what happens to it.
      }
    }

    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Path-mutation coordination (003)                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Reserves a filesystem path mutation against overlapping document work.
   *
   * This is the one place Open, Save As, Rename and Delete agree on which
   * canonical destinations are taken (FR-099, FR-100, FR-103):
   *
   * 1. a destination another live session owns, another Save As reserved, or
   *    another mutation claimed is refused with a contract-shaped error;
   * 2. the claim is registered before anything is awaited, so a later Open or
   *    Save As sees it and waits instead of racing;
   * 3. in-flight opens, saves and writes on either side — including pending
   *    operations *below* a renamed or deleted directory — are awaited, so a
   *    stale completion cannot register or restore the old path.
   *
   * The caller must release the reservation once the disk operation and its
   * state commit are done.
   */
  async reservePathMutation(
    request: PathMutationRequest,
  ): Promise<PathMutationResult> {
    const destinationKey = request.destinationKey ?? null;

    if (destinationKey !== null && destinationKey !== request.sourceKey) {
      // No `await` may appear between these checks and the claim below: the
      // decision has to be atomic with the registration.
      if (this.openPathIndex.has(destinationKey)) {
        return {
          status: "failed",
          error: this.contractError(
            "path_resolution",
            "That name is already open in another tab.",
          ),
        };
      }
      if (this.pendingPathClaims.has(destinationKey)) {
        return {
          status: "failed",
          error: this.contractError(
            "path_resolution",
            "That destination is already being saved.",
          ),
        };
      }
      if (this.mutationCovering(destinationKey) !== null) {
        return {
          status: "failed",
          error: this.contractError(
            "path_resolution",
            "That destination is already being changed by another operation.",
          ),
        };
      }
    }

    const claim = this.createPathMutationClaim(
      request.sourceKey,
      destinationKey,
    );

    await this.waitForPathActivity(request.sourceKey, destinationKey, claim);

    return { status: "reserved", reservation: { release: claim.release } };
  }

  /**
   * Commits a successful filesystem rename.
   *
   * The renamed entry's owning session keeps its id, editor state, history and
   * dirty flag — only path-related metadata moves (FR-061). Open documents below
   * a renamed directory are re-derived from their own canonical paths, so the
   * directory contents are never scanned on disk (FR-062).
   *
   * Returns the affected document ids.
   */
  commitRenamedPath(request: CommittedPathRename): readonly DocumentId[] {
    const sourceKey = request.sourceIdentity.comparisonKey;
    const affected: DocumentId[] = [];

    const ownerId = this.openPathIndex.get(sourceKey);
    const owner =
      ownerId === undefined ? undefined : this.sessions.get(ownerId);

    if (owner !== undefined) {
      this.openPathIndex.delete(sourceKey);
      this.openPathIndex.set(request.newIdentity.comparisonKey, owner.id);
      this.applyPath(owner, request.newPath, request.newIdentity);
      affected.push(owner.id);
    }

    const identified =
      request.affectedDocumentIds === undefined
        ? null
        : new Set(request.affectedDocumentIds);

    for (const session of this.listSessions()) {
      if (session === owner) {
        continue;
      }

      const identity = session.pathIdentity;
      if (identity === null) {
        continue;
      }
      if (!isWithinDirectory(sourceKey, identity.comparisonKey)) {
        continue;
      }
      // A caller that identified the affected documents with the canonical
      // relation command owns that decision; the canonical containment above is
      // then only a consistency check that the session really is below the
      // renamed entry.
      if (identified !== null && !identified.has(session.id)) {
        continue;
      }

      const canonicalSuffix = relativeWithinDirectory(
        request.sourceIdentity.canonicalPath,
        identity.canonicalPath,
      );
      const keySuffix = relativeWithinDirectory(
        sourceKey,
        identity.comparisonKey,
      );
      if (
        canonicalSuffix === null ||
        keySuffix === null ||
        canonicalSuffix === ""
      ) {
        continue;
      }

      const nextPath = joinPath(request.newPath, canonicalSuffix);
      const nextIdentity: ResolvedPathIdentity = {
        requestedPath: nextPath,
        canonicalPath: joinPath(request.newIdentity.canonicalPath, canonicalSuffix),
        comparisonKey: joinPath(request.newIdentity.comparisonKey, keySuffix),
        kind: identity.kind,
        diskRevision: identity.diskRevision,
      };

      this.openPathIndex.delete(identity.comparisonKey);
      this.openPathIndex.set(nextIdentity.comparisonKey, session.id);
      this.applyPath(session, nextPath, nextIdentity);
      affected.push(session.id);
    }

    if (affected.length > 0) {
      this.emitSnapshot();
    }

    return affected;
  }

  /**
   * Every open session whose current path is `key` or below it.
   *
   * Containment is decided component by component on canonical comparison keys,
   * so a sibling such as `D:\project-old` is never counted as being under
   * `D:\project`, and no disk descendants are scanned (FR-072).
   */
  findSessionsUnder(key: string): readonly DocumentSession[] {
    return this.listSessions().filter((session) => {
      const sessionKey = session.pathIdentity?.comparisonKey;
      return sessionKey !== undefined && isWithinDirectory(key, sessionKey);
    });
  }

  /**
   * Removes sessions whose files an external filesystem operation deleted.
   *
   * This deliberately does not run the ordinary close flow: the file is already
   * in the recycle bin, so there is nothing left to save and no second
   * unsaved-work prompt may appear (FR-071, FR-074).
   */
  removeDeletedSessions(ids: readonly DocumentId[]): readonly DocumentId[] {
    const removed: DocumentId[] = [];

    for (const id of ids) {
      if (!this.sessions.has(id)) {
        continue;
      }
      this.removeSession(id);
      removed.push(id);
    }

    return removed;
  }

  /** Points a session at a new path without touching its document state. */
  private applyPath(
    session: DocumentSession,
    path: string,
    identity: ResolvedPathIdentity,
  ): void {
    session.path = path;
    session.pathIdentity = identity;
    session.displayName = displayNameForPath(path);
  }

  /** The first active path mutation that covers `key`, if any. */
  private mutationCovering(key: string): PathMutationClaim | null {
    for (const claim of this.pathMutations.values()) {
      if (claim.destinationKey === key) {
        return claim;
      }
      if (isWithinDirectory(claim.sourceKey, key)) {
        return claim;
      }
    }
    return null;
  }

  /** Registers a mutation claim and returns it. */
  private createPathMutationClaim(
    sourceKey: string,
    destinationKey: string | null,
  ): PathMutationClaim {
    const id = this.nextPathMutationId;
    this.nextPathMutationId += 1;

    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const claim: PathMutationClaim = {
      id,
      sourceKey,
      destinationKey,
      settled,
      release: () => {
        // Identity-checked, so a stale release can never drop a newer claim.
        if (this.pathMutations.get(id) === claim) {
          this.pathMutations.delete(id);
          settle();
        }
      },
    };

    this.pathMutations.set(id, claim);
    return claim;
  }

  /**
   * Waits for in-flight document operations that touch the mutated paths.
   */
  private async waitForPathActivity(
    sourceKey: string,
    destinationKey: string | null,
    own: PathMutationClaim,
  ): Promise<void> {
    const waits: Promise<unknown>[] = [];
    const collect = (key: string): void => {
      const write = this.writeChains.get(key);
      if (write !== undefined) {
        waits.push(write);
      }
      const open = this.pendingOpens.get(key);
      if (open !== undefined) {
        waits.push(open);
      }
    };

    collect(sourceKey);
    if (destinationKey !== null) {
      collect(destinationKey);
    }

    // A pending Save As *below* a directory that is being renamed or deleted
    // has not finished committing yet even after its write resolved, so the
    // claim itself has to be awaited.
    for (const [key, claim] of this.pendingPathClaims) {
      if (
        isWithinDirectory(sourceKey, key) ||
        (destinationKey !== null && key === destinationKey)
      ) {
        waits.push(claim.settled);
      }
    }

    // A pending Open or Save As *below* a directory that is being renamed or
    // deleted would commit the old path if it were allowed to finish first.
    const relatedKeys = new Set<string>([
      ...this.pendingOpens.keys(),
      ...this.writeChains.keys(),
      ...this.pendingPathClaims.keys(),
    ]);
    for (const key of relatedKeys) {
      if (isWithinDirectory(sourceKey, key)) {
        collect(key);
      }
    }

    for (const claim of this.pathMutations.values()) {
      if (claim.id === own.id) {
        continue;
      }
      if (isWithinDirectory(sourceKey, claim.sourceKey)) {
        waits.push(claim.settled);
      }
      if (
        claim.destinationKey !== null &&
        isWithinDirectory(sourceKey, claim.destinationKey)
      ) {
        waits.push(claim.settled);
      }
    }

    if (waits.length > 0) {
      await Promise.all(waits);
    }
  }

  /** Builds a contract-shaped error without reporting it. */
  private contractError(
    code: FileCommandError["code"],
    message: string,
  ): FileCommandError {
    return { code, message };
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
  private async commitSave(
    id: DocumentId,
    generation: number,
    snapshot: Text,
    adoption: ResolvedPathIdentity | null,
  ): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined || session.latestSaveGeneration !== generation) {
      return { status: "success" };
    }

    if (adoption !== null && !this.adoptPath(session, adoption, generation)) {
      // FR-102: a path-changing save whose destination could not be adopted
      // must not move the path, advance the baseline or report the document
      // clean — that would claim ownership the document does not have.
      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `${adoption.requestedPath} is already open in another tab.`,
        ),
      };
    }

    session.savedBaseline = snapshot;
    const dirty = !session.editorState.doc.eq(snapshot);
    const dirtyChanged = dirty !== session.dirty;
    session.dirty = dirty;

    if (adoption !== null || dirtyChanged) {
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
   * completion must never delete the claim a newer Save As renewed. Releasing
   * also settles the claim, which is what an Open waiting on the destination
   * was blocked on.
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
      claim.settle();
    }
  }

  /** Creates a destination reservation an Open can wait on. */
  private createPathClaim(id: DocumentId, generation: number): PathClaim {
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    return { documentId: id, generation, settled, settle };
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
      // Zero documents is a valid steady state (FR-012, FR-014): closing the
      // final Tab leaves no active document and creates no replacement
      // Untitled document.
      this.activeDocumentId = null;
      this.emitSnapshot();
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
        // A closed document can never finish its Save As, so anything waiting on
        // that destination has to be released rather than blocked forever.
        claim.settle();
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
