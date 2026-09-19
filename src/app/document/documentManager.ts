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

import { createEditorState, createExternalReloadState } from "../../editor/editorConfig";
import type { EditorHandle } from "../../editor/editorHandle";
import type { FileDialogService } from "../../services/fileDialogs";
import {
  isFileCommandError,
  toFileCommandError,
  type DocumentPathInspection,
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
import type {
  DiskValidationResult,
  DiskValidator,
} from "./diskValidation";
import type {
  CapturedWatchHint,
  InternalFsOperation,
  InternalFsOperationGuard,
  InternalFsOperationKind,
  InternalPathClaim,
} from "./internalFsOperationGuard";
import {
  NEW_DOCUMENT_FORMAT,
  createDefaultViewState,
  createDocumentId,
  displayNameForPath,
  untitledDisplayName,
  type DocumentId,
  type DocumentManagerSnapshot,
  type DocumentSession,
  type ExternalState,
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
  /**
   * External-change validation (005).
   *
   * Required rather than optional: FR-013 makes disk validation immediately
   * before writing a bound path mandatory, so a construction that silently omits
   * it would drop a data-safety guarantee instead of failing loudly.
   */
  diskValidator: DiskValidator;
  /**
   * Reconciles the filesystem notifications Sorakada's own mutations produce
   * (FR-035, FR-036). Shared with the opened-document watcher consumer, which is
   * what lets an own-write hint be reconciled against the post-write state.
   */
  internalFsOperations: InternalFsOperationGuard;
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
   * What the caller is about to do.
   *
   * Required, because the internal-operation guard has to know which paths the
   * mutation is *expected* to add and remove before it can reconcile the
   * notifications the disk operation will produce (FR-035, FR-036).
   */
  kind: PathMutationKind;
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

/** The filesystem mutations an Explorer path mutation can perform. */
export type PathMutationKind = "create" | "rename" | "delete";

/** Receives hints an internal operation could not reconcile (FR-036). */
export type ReconciliationListener = (
  hints: readonly CapturedWatchHint[],
) => void;

/** Outcome of reserving a path mutation. */
export type PathMutationResult =
  | { status: "reserved"; reservation: PathMutationReservation }
  | { status: "failed"; error: FileCommandError };

/** A path mutation that has been reserved and not yet released. */
interface PathMutationClaim {
  id: number;
  kind: PathMutationKind;
  sourceKey: string;
  destinationKey: string | null;
  /** Settles when this mutation is released. */
  settled: Promise<void>;
  release(): void;
  /**
   * The internal-operation guard claim bracketing this mutation (005).
   *
   * It is settled from the commit that actually confirms the post-operation disk
   * state — `commitRenamedPath` or `removeDeletedSessions` — and, when the caller
   * releases without a commit (a failed or cancelled disk operation), as a
   * *failed* mutation. That distinction is what keeps a genuinely outside change
   * during the operation discoverable (FR-036).
   */
  operation: InternalFsOperation;
  /** Whether a commit already settled the guard claim. */
  reconciled: boolean;
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

/**
 * How many times a completed write may be re-proved while its own notifications
 * are still arriving (T064).
 *
 * The bound exists so a pathological stream of same-path notifications cannot turn
 * one save into an unbounded read loop. Reaching it is not a failure: the
 * operation then reconciles nothing and the still-held hints are validated against
 * the disk instead, which is the safe answer for both Sorakada's own write and a
 * genuine outside one.
 */
const MAX_SETTLEMENT_RECHECKS = 3;

/**
 * The parent directory of a user-facing path, or `null` when there is none.
 *
 * Deliberately textual: the caller validates the result *on disk* immediately
 * afterwards (`inspect_document_path`), so this never needs to be canonical — and
 * it has to work for a path whose file was just deleted, which is precisely the
 * case a recreation needs to inspect.
 */
function parentDirectoryOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const base = trimmed === "" ? path : trimmed;
  const separatorIndex = Math.max(base.lastIndexOf("\\"), base.lastIndexOf("/"));

  // A bare leaf is relative to the current directory, which is a real parent.
  if (separatorIndex === -1) {
    return ".";
  }
  // `\notes.txt`: the parent is the root itself.
  if (separatorIndex === 0) {
    return base.slice(0, 1);
  }

  const parent = base.slice(0, separatorIndex);
  // A drive-relative root such as `D:` needs its separator back to stay absolute.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/**
 * Whether a validated disk snapshot still represents exactly what the session
 * holds as its saved baseline.
 *
 * The normalized text *and* the byte-relevant format fields are compared, because
 * `write_text_file` consumes exactly those three format fields: a BOM or EOL
 * change is a real change on disk even when the normalized text is identical
 * (T061). `detectedLineEnding` is deliberately excluded — it describes the previous
 * read rather than the bytes a write produces, so a Mixed file Sorakada wrote back
 * as CRLF must not look different from itself.
 */
function snapshotMatchesBaseline(
  content: OpenTextFileResult,
  session: DocumentSession,
): boolean {
  if (content.text !== session.savedBaseline.toString()) {
    return false;
  }

  const disk = content.format;
  const baseline = session.format;
  return (
    disk.encoding === baseline.encoding &&
    disk.bom === baseline.bom &&
    disk.preferredLineEnding === baseline.preferredLineEnding
  );
}

/** The binding a document's path currently has, as an async result must check it. */
export interface DocumentBinding {
  documentId: DocumentId;
  /** The bound path exactly as the session spells it. */
  path: string;
  /** Canonical comparison identity the session owns. */
  comparisonKey: string;
  /** The session's binding generation when the operation started. */
  generation: number;
  /**
   * The identity, including the disk revision, the session has adopted.
   *
   * Validation compares the observed metadata against exactly this revision, so
   * it is captured with the binding rather than re-read later (which would let a
   * concurrent save move the goalposts mid-validation).
   */
  identity: ResolvedPathIdentity;
}

/** A validated disk snapshot the manager may adopt for a still-current binding. */
export interface ValidatedDiskSnapshot {
  /** The freshly observed identity, whose revision is what a commit advances to. */
  identity: ResolvedPathIdentity;
  /**
   * The disk content the caller read.
   *
   * Required, and deliberately so: a metadata-only validation result means
   * "nothing diverged", which is {@link DocumentManager.adoptVerifiedIdentity},
   * while content means "here is what the disk now holds". Collapsing the two
   * would make a dirty document's divergence look like an unchanged file.
   */
  content: OpenTextFileResult;
}

/** What adopting a validated snapshot did to the session. */
export type DiskCommitOutcome =
  /** The buffer was replaced by the disk version and the baseline advanced. */
  | "reloaded"
  /** Nothing visibly changed, but the adopted revision/format may have advanced. */
  | "unchanged"
  /** A dirty document met a divergent disk: the buffer was kept (FR-021). */
  | "external-modified"
  /** The document was closed or rebound while the result was in flight (FR-039). */
  | "stale";

/**
 * What proving a completed write against the disk found (T060).
 *
 * "The target exists" is not a proof: an outside writer can land between
 * Sorakada's write and the check, and treating that as "our own write settled"
 * would hide a real divergence and let the saved baseline advance past content
 * Sorakada never wrote (FR-036, Constitution I).
 */
type WrittenState =
  | {
      status: "confirmed";
      /** The verified identity/revision; `null` when the inspection reported none. */
      identity: ResolvedPathIdentity | null;
    }
  /** The disk holds something other than what this operation wrote. */
  | { status: "diverged"; identity: ResolvedPathIdentity | null }
  /** The disk could not be inspected or read back at all. */
  | { status: "unverifiable"; identity: ResolvedPathIdentity | null };

/**
 * A bound-path interest change the opened-document watcher must follow.
 *
 * The manager owns *which* documents are bound and announces every change, so the
 * watcher consumer never has to infer interest by polling sessions, and a path
 * change can never leave a stale subscription behind (FR-001–FR-004, FR-044).
 */
export type WatchInterestChange =
  | {
      type: "bound";
      documentId: DocumentId;
      path: string;
      identity: ResolvedPathIdentity;
    }
  | {
      type: "rebound";
      documentId: DocumentId;
      previousPath: string;
      previousIdentity: ResolvedPathIdentity;
      path: string;
      identity: ResolvedPathIdentity;
    }
  | {
      type: "unbound";
      documentId: DocumentId;
      path: string;
      identity: ResolvedPathIdentity;
    };

/** Receives every bound-path interest change. */
export type WatchInterestListener = (change: WatchInterestChange) => void;

/** Receives the id of a bound document the user just activated (FR-012). */
export type ActivationListener = (documentId: DocumentId) => void;

export class DocumentManager {
  private readonly editor: EditorHandle;
  private readonly fileService: FileService;
  private readonly dialogs: FileDialogService;
  private readonly activationBenchmark: ActivationRecorder | null;
  private readonly diskValidator: DiskValidator;
  private readonly internalFsOperations: InternalFsOperationGuard;

  private readonly orderedIds: DocumentId[] = [];
  private readonly sessions = new Map<DocumentId, DocumentSession>();
  private readonly listeners = new Set<DocumentManagerListener>();
  /** Consumers of bound-path interest changes (005). */
  private readonly watchInterestListeners = new Set<WatchInterestListener>();
  /** Consumers of user Tab activations (005, FR-012). */
  private readonly activationListeners = new Set<ActivationListener>();
  /** Consumers of hints an internal operation could not reconcile (005). */
  private readonly reconciliationListeners = new Set<ReconciliationListener>();
  /**
   * The last external-validation error already shown for a document.
   *
   * A locked or permission-denied file must be reported non-destructively
   * (FR-043) *without* turning every watcher hint or focus pass into another
   * modal dialog (FR-041), so the same message is reported once until a
   * validation succeeds or the message changes.
   */
  private readonly reportedValidationErrors = new Map<DocumentId, string>();

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
    this.diskValidator = deps.diskValidator;
    this.internalFsOperations = deps.internalFsOperations;

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
  /* External change (005)                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Subscribes to bound-path interest changes.
   *
   * The watcher consumer uses this instead of polling sessions, so a document
   * that successfully becomes bound, migrates its path (Save As, internal
   * Explorer Rename) or closes always leaves the right watch interest behind
   * (FR-001–FR-004, FR-023/T023).
   */
  subscribeWatchInterest(listener: WatchInterestListener): () => void {
    this.watchInterestListeners.add(listener);
    return () => {
      this.watchInterestListeners.delete(listener);
    };
  }

  /**
   * Subscribes to user Tab activations.
   *
   * Only the user path (`selectDocument`) reports here, so opening, New and
   * drag/drop do not add a redundant validation pass to their own activation
   * (FR-012).
   */
  subscribeActivation(listener: ActivationListener): () => void {
    this.activationListeners.add(listener);
    return () => {
      this.activationListeners.delete(listener);
    };
  }

  /**
   * Subscribes to hints an internal operation could not reconcile.
   *
   * The guard refuses to declare a mismatching post-operation disk state
   * internal (FR-036), so those hints have to reach the watcher consumer, which
   * validates them like any other external hint. This is the difference between
   * reconciling an own operation and swallowing outside edits.
   */
  subscribeReconciliation(listener: ReconciliationListener): () => void {
    this.reconciliationListeners.add(listener);
    return () => {
      this.reconciliationListeners.delete(listener);
    };
  }

  /**
   * The binding an asynchronous validation or reload must present to mutate this
   * document, or `null` when it is unbound or already closed.
   */
  getBinding(id: DocumentId): DocumentBinding | null {
    const session = this.sessions.get(id);
    const identity = session?.pathIdentity;
    if (
      session === undefined ||
      session.path === null ||
      identity === undefined ||
      identity === null
    ) {
      return null;
    }

    return {
      documentId: id,
      path: session.path,
      comparisonKey: identity.comparisonKey,
      generation: session.bindingGeneration,
      identity,
    };
  }

  /**
   * Whether `binding` still describes this document's current bound path.
   *
   * This is the one stale-result check every asynchronous completion must pass
   * (FR-039): it fails for a closed document, for an id that was closed and
   * reopened, and for a document that Save As or an internal Explorer Rename has
   * since pointed somewhere else.
   */
  isBindingCurrent(binding: DocumentBinding): boolean {
    const session = this.sessions.get(binding.documentId);
    if (session === undefined || session.path === null) {
      return false;
    }
    return (
      session.bindingGeneration === binding.generation &&
      session.path === binding.path &&
      session.pathIdentity?.comparisonKey === binding.comparisonKey
    );
  }

  /**
   * Adopts a validated *metadata-only* observation of an unchanged path.
   *
   * Nothing about the document is replaced: the adopted revision is simply
   * advanced to what the disk reports, so the next validation compares against
   * current metadata instead of re-reading a file that did not change. A session
   * whose disk state was recorded as `missing`/`modified` returns to `normal`
   * here, because the caller has just verified the path against the baseline.
   */
  adoptVerifiedIdentity(
    binding: DocumentBinding,
    identity: ResolvedPathIdentity,
  ): boolean {
    const session = this.sessions.get(binding.documentId);
    if (session === undefined || !this.isBindingCurrent(binding)) {
      return false;
    }

    session.pathIdentity = identity;
    this.forgetValidationError(session.id);
    this.setExternalState(session, "normal");
    return true;
  }

  /**
   * Applies a validated disk snapshot to a document whose binding is still current.
   *
   * This is the only way an external disk version may reach a session, and it
   * enforces the whole clean/dirty split in one place:
   *
   * - identical supported text is *not* a reload, so a metadata-only touch never
   *   clears undo history or disturbs the buffer (spec edge case); the new format
   *   and revision are still adopted, because a BOM/EOL change is a real disk
   *   change the next save must respect;
   * - a dirty document with different disk text becomes `modified` and keeps its
   *   buffer (FR-021, FR-022);
   * - a clean document adopts the disk version, clears undo/redo, preserves and
   *   clamps its selections, and stays clean (FR-016–FR-019).
   *
   * `options.replaceDirty` is only legal after the user explicitly confirmed
   * discarding unsaved work (FR-027) and is therefore never set by the automatic
   * watcher path.
   */
  applyValidatedDiskSnapshot(
    binding: DocumentBinding,
    snapshot: ValidatedDiskSnapshot,
    options: { replaceDirty?: boolean } = {},
  ): DiskCommitOutcome {
    const session = this.sessions.get(binding.documentId);
    if (session === undefined || !this.isBindingCurrent(binding)) {
      return "stale";
    }

    const content = snapshot.content;
    const matchesBaseline = snapshotMatchesBaseline(content, session);

    if (matchesBaseline) {
      // A metadata-only touch, or a rewrite with identical supported text *and*
      // byte-relevant format: no reload, no dirty disruption, no cleared history.
      // The format and revision may advance because they describe exactly the bytes
      // the baseline holds (T061).
      session.format = content.format;
      session.pathIdentity = snapshot.identity;
      this.forgetValidationError(session.id);
      this.setExternalState(session, "normal");
      return "unchanged";
    }

    if (session.dirty && options.replaceDirty !== true) {
      // The disk diverged while the document is dirty: the buffer is kept and the
      // adopted revision deliberately does NOT advance. Adopting it would make the
      // divergence look resolved to every later validation, so the next Save would
      // overwrite the external version without ever asking (FR-021, FR-023).
      this.setExternalState(session, "modified");
      return "external-modified";
    }

    // From here the disk version really is adopted, so the format, revision and
    // baseline all move together.
    session.format = content.format;
    session.pathIdentity = snapshot.identity;
    this.forgetValidationError(session.id);

    const nextState = createExternalReloadState(
      session.editorState,
      content.text,
      this.editor.extensions,
    );
    session.editorState = nextState;
    session.savedBaseline = nextState.doc;
    session.dirty = false;
    this.setExternalState(session, "normal");

    if (this.activeDocumentId === session.id && this.editor.isReady()) {
      // A background document is reloaded in place without being activated
      // (US1 scenario 4); only the visible one is pushed into the shared view.
      this.editor.reloadDocumentState(session.id, nextState);
    }

    this.emitSnapshot();
    return "reloaded";
  }

  /**
   * Transitions a still-current document's external disk state.
   *
   * `normal` is only ever reached through a successful adoption; `modified` and
   * `missing` are recorded without touching the buffer or `dirty` (FR-021,
   * FR-028, FR-029).
   */
  markExternalState(binding: DocumentBinding, state: ExternalState): boolean {
    const session = this.sessions.get(binding.documentId);
    if (session === undefined || !this.isBindingCurrent(binding)) {
      return false;
    }
    this.setExternalState(session, state);
    return true;
  }

  /**
   * Surfaces an external-validation failure non-destructively (FR-043).
   *
   * The buffer and every state field are left alone: an unverifiable path must
   * never become `missing` (FR-015). The same message is shown once per document,
   * so a locked file does not turn every watcher hint into another modal dialog
   * (FR-041); a later successful validation clears it and a later trigger retries.
   */
  async markValidationError(
    binding: DocumentBinding,
    error: FileCommandError,
  ): Promise<boolean> {
    if (!this.isBindingCurrent(binding)) {
      return false;
    }

    const alreadyReported =
      this.reportedValidationErrors.get(binding.documentId) === error.message;
    if (!alreadyReported) {
      this.reportedValidationErrors.set(binding.documentId, error.message);
      await this.dialogs.showError(error.message);
    }

    return true;
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
    // FR-012: a user activation revalidates the target bound document. This is
    // announced here rather than performed by TabBar, so the UI keeps owning
    // presentation only and every activation surface behaves the same.
    if (this.getBinding(id) !== null) {
      this.notifyActivation(id);
    }
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
      externalState: "normal",
      bindingGeneration: 0,
    };

    this.orderedIds.push(session.id);
    this.sessions.set(session.id, session);
    this.openPathIndex.set(identity.comparisonKey, session.id);
    this.activateDocument(session.id);

    // Interest is announced only after the session exists, so the consumer can
    // immediately read the binding it must watch (FR-001, FR-044).
    this.notifyWatchInterest({
      type: "bound",
      documentId: session.id,
      path,
      identity,
    });

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

    const binding = this.getBinding(id);
    if (binding === null) {
      return { status: "success" };
    }

    // FR-013: mandatory validation immediately before writing the bound path.
    // A previously missed external change has to be discovered here even if the
    // realtime watcher never reported it (FR-026).
    const validation = await this.diskValidator.validate({
      binding,
      trigger: "pre-save",
      isCurrent: () => this.isBindingCurrent(binding),
    });

    if (validation.outcome === "stale") {
      // The document was closed or rebound while validation ran, so the newer
      // state — not this save — owns what happens next (FR-039).
      return { status: "success" };
    }

    // FR-030: this branch runs before the ordinary clean-document no-op, so a
    // clean missing document can be recreated by Save too.
    if (validation.outcome === "missing") {
      // FR-014: a confirmed absence is recorded before anything is attempted, so
      // a failed recreation still leaves the user looking at a `missing` document
      // rather than at a stale `normal` state.
      this.markExternalState(binding, "missing");
      return this.recreateMissingDocument(id, binding);
    }

    if (validation.outcome === "unverifiable") {
      // FR-043: a failure to verify is surfaced non-destructively for a clean
      // document too, instead of a silent success that hides a path Sorakada
      // could not read. Everything — buffer, baseline, format, dirty flag,
      // external state and disk — stays exactly as it was (T063), and repeating
      // the same failure does not repeat the dialog.
      await this.markValidationError(binding, validation.error);
      if (!session.dirty) {
        // Nothing needed writing, so the save itself did not fail.
        return { status: "success" };
      }
      return { status: "failed", error: validation.error };
    }

    if (validation.outcome === "changed") {
      return this.resolveSaveDivergence(id, binding, validation);
    }

    if (!session.dirty) {
      // A clean same-path Save stays a deliberate no-op: Sorakada does not retain
      // per-line EOL provenance, so rewriting an unedited Mixed file would
      // normalize bytes the user never touched.
      return { status: "success" };
    }

    return this.writeBoundDocument(id, "save");
  }

  /**
   * Applies the divergence rules for a save that found a different disk revision.
   *
   * Shared by the ordinary Save path and the missing-file recreation path,
   * because a target that reappeared before the recreate must follow exactly the
   * same clean-reappearance / dirty-conflict rules as any other external change
   * (FR-033, FR-034, FR-045).
   *
   * The disk snapshot is compared with the document's own baseline before any
   * conflict is declared, because "the revision moved" and "the content changed"
   * are different facts (T061): a metadata-only touch must not turn into an
   * overwrite prompt, and a real text/format divergence must.
   */
  private async resolveSaveDivergence(
    id: DocumentId,
    binding: DocumentBinding,
    validation: Extract<DiskValidationResult, { outcome: "changed" }>,
  ): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined || !this.isBindingCurrent(binding)) {
      return { status: "success" };
    }

    if (!session.dirty) {
      // A clean document has no Sorakada-only content, so adopting the disk
      // version is the only meaningful outcome and cannot lose user work.
      this.applyValidatedDiskSnapshot(binding, {
        identity: validation.identity,
        content: validation.content,
      });
      return { status: "success" };
    }

    if (snapshotMatchesBaseline(validation.content, session)) {
      // The supported disk text and format are exactly what this document already
      // holds as its baseline, so nothing external diverged: adopt the fresh
      // revision (and only the revision — the bytes are equivalent, T061) and let
      // the ordinary save proceed without asking anything.
      this.adoptVerifiedIdentity(binding, validation.identity);
      return this.writeBoundDocument(id, "save");
    }

    // FR-021: the divergence is recorded before the user is asked, so a
    // cancelled overwrite still leaves the conflict visible in the Tab.
    this.markExternalState(binding, "modified");

    // FR-023/FR-026/FR-042: ordinary Save is blocked until the user explicitly
    // chooses Overwrite; anything else is Cancel and changes nothing (FR-024).
    const choice = await this.dialogs.confirmExternalOverwrite(
      session.displayName,
    );
    if (choice !== "overwrite") {
      return { status: "cancelled" };
    }

    // The dialog was awaited, so the document may have been closed, rebound or
    // emptied by Undo in the meantime; only a still-dirty current binding may
    // continue into the write.
    const live = this.sessions.get(id);
    if (
      live === undefined ||
      !live.dirty ||
      !this.isBindingCurrent(binding)
    ) {
      return { status: "success" };
    }

    return this.writeBoundDocument(id, "save");
  }

  /**
   * Writes the current in-memory content to the document's bound path.
   *
   * This is the single place an ordinary Save, an explicit Overwrite and a
   * missing-file recreation reach the writer (Constitution IV), so all three
   * share the same save generation, per-destination write chain and
   * internal-operation reconciliation.
   *
   * The write is bracketed by the internal filesystem operation guard: the
   * notifications the write itself produces are reconciled against the
   * post-operation disk state instead of being mistaken for an outside change
   * (FR-035, FR-036), while a mismatching post-operation state still leaves the
   * captured hints to be validated.
   */
  private async writeBoundDocument(
    id: DocumentId,
    kind: InternalFsOperationKind,
  ): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined || session.path === null) {
      return { status: "success" };
    }
    if (!session.dirty && kind === "save") {
      return { status: "success" };
    }

    const binding = this.getBinding(id);
    if (binding === null) {
      return { status: "success" };
    }

    const targetPath = session.path;
    const generation = session.latestSaveGeneration + 1;
    session.latestSaveGeneration = generation;
    const snapshot = session.editorState.doc;
    const format = session.format;
    const claimKey = session.pathIdentity?.comparisonKey ?? targetPath;
    const request: WriteTextFileRequest = {
      path: targetPath,
      text: snapshot.toString(),
      bom: format.bom,
      lineEnding: format.preferredLineEnding,
    };

    const operation = this.internalFsOperations.beginMutation({
      kind,
      claims: [
        {
          path: targetPath,
          comparisonKey: claimKey,
          effect: kind === "recreate" ? "create" : "write",
        },
      ],
    });

    try {
      if (kind === "recreate") {
        // FR-045 / T059: create-if-absent, so a target that appeared between the
        // final validation and this write is reported instead of overwritten.
        await this.enqueueCreate(claimKey, request);
      } else {
        await this.enqueueWrite(claimKey, request);
      }
    } catch (error) {
      // Nothing was written, so no captured hint may be declared internal; the
      // guard hands every one of them back to be validated as real divergence.
      this.settleMutation(operation, { succeeded: false, confirmed: [] });
      const failure = toFileCommandError(error, "io_write");

      if (kind === "recreate" && failure.code === "already_exists") {
        // The target reappeared exactly at the write boundary. Sorakada wrote
        // nothing and the disk content is untouched, so the ordinary reappearance
        // rules own what happens next (FR-045).
        return this.resolveReappearedTarget(id, binding);
      }

      return { status: "failed", error: await this.reportError(error, "io_write") };
    }

    return this.finishWrite({
      id,
      generation,
      snapshot,
      request,
      operation,
      claimKey,
      // Save, Overwrite and recreate all write to the path the document already
      // owns, so a failed proof must never move it.
      fallbackIdentity: null,
    });
  }

  /**
   * Proves that the bytes now on disk are exactly what this operation wrote (T060).
   *
   * Finding the target present is not a proof: an outside writer can land between
   * Sorakada's write and this check, and accepting that as "our own write" would
   * both hide a real divergence and let the saved baseline advance past content
   * Sorakada never wrote (FR-036, Constitution I). The supported snapshot is
   * therefore read back and compared — the normalized text plus the two
   * byte-relevant format fields `write_text_file` consumes (`bom`, `lineEnding`).
   *
   * `detectedLineEnding`/`encoding` are deliberately not compared: they describe
   * the read, not the bytes a write produces.
   */
  private async confirmWrittenSnapshot(
    request: WriteTextFileRequest,
  ): Promise<WrittenState> {
    let inspection: DocumentPathInspection;
    try {
      inspection = await this.fileService.inspectDocumentPath(request.path);
    } catch {
      return { status: "unverifiable", identity: null };
    }

    const identity: ResolvedPathIdentity | null =
      inspection.state === "file" &&
      inspection.canonicalPath !== null &&
      inspection.comparisonKey !== null &&
      inspection.diskRevision !== null
        ? {
            requestedPath: request.path,
            canonicalPath: inspection.canonicalPath,
            comparisonKey: inspection.comparisonKey,
            kind: "file",
            diskRevision: inspection.diskRevision,
          }
        : null;

    if (inspection.state === "missing") {
      // We just wrote it, so absence is an outside change, not a failed write.
      return { status: "diverged", identity: null };
    }
    if (inspection.state !== "file") {
      return { status: "unverifiable", identity };
    }

    let content: OpenTextFileResult;
    try {
      content = await this.fileService.readTextFile(request.path);
    } catch {
      return { status: "unverifiable", identity };
    }

    const matches =
      content.text === request.text &&
      content.format.bom === request.bom &&
      content.format.preferredLineEnding === request.lineEnding;

    return matches
      ? { status: "confirmed", identity }
      : { status: "diverged", identity };
  }

  /**
   * Commits a write that already reached the disk.
   *
   * Shared by every writer — Save, Overwrite, recreate and Save As — so the proof,
   * the baseline commit and the internal-operation settlement can never disagree
   * (T060).
   *
   * Only a `confirmed` proof may declare the operation's own notifications
   * reconciled or return the document to external `normal`. When the proof fails,
   * the baseline still advances (the write did happen), but the operation claims
   * nothing: every captured hint is handed back for revalidation, the adopted
   * revision is degraded to "unknown" so the next validation compares content
   * again, and a real divergence is recorded as `modified` instead of being
   * papered over.
   */
  private async finishWrite(params: {
    id: DocumentId;
    generation: number;
    snapshot: Text;
    request: WriteTextFileRequest;
    operation: InternalFsOperation;
    claimKey: string;
    /**
     * The identity to adopt when the proof could not confirm the disk.
     *
     * Save As must still adopt its chosen destination even then — the write did
     * happen — while every other writer keeps the path it already owns.
     */
    fallbackIdentity: ResolvedPathIdentity | null;
  }): Promise<CommandResult> {
    const { id, generation, snapshot, request, operation, claimKey } = params;

    // T064: a proof only explains the notifications that arrived *before* it. The
    // write's own notifications keep arriving while the guard still holds this
    // path, and a same-path external write can land in exactly that window, so the
    // disk is re-proved until a proof completes with no notification for this key
    // arriving during it. At that point every held notification is explained by
    // this operation's own write, and the proof — not a count — is the evidence.
    let proof: WrittenState;
    let capturedBefore: number;
    let rechecks = 0;
    for (;;) {
      capturedBefore = this.internalFsOperations.capturedHintCountFor(claimKey);
      proof = await this.confirmWrittenSnapshot(request);
      const capturedAfter =
        this.internalFsOperations.capturedHintCountFor(claimKey);

      if (capturedAfter === capturedBefore) {
        // Nothing arrived during this proof, so it covers every notification held
        // for this key.
        break;
      }
      if (rechecks >= MAX_SETTLEMENT_RECHECKS) {
        // A pathological notification stream: stop re-reading, and let the
        // settlement reconcile nothing rather than guess (see below).
        break;
      }
      rechecks += 1;
    }

    // A notification that arrived after the final proof leaves the operation unable
    // to attribute its own notifications, so it reconciles nothing and the consumer
    // validates them against the disk instead (FR-036).
    const unattribute =
      this.internalFsOperations.capturedHintCountFor(claimKey) !== capturedBefore;
    const confirmed = proof.status === "confirmed" && !unattribute;

    // Only a confirmed proof may adopt the identity the inspection reported: for a
    // diverged/unverifiable result that identity describes content Sorakada did not
    // write, and adopting its revision would make the next validation conclude
    // "unchanged" from metadata that says nothing about the baseline.
    const adoption = confirmed
      ? (proof.identity ?? params.fallbackIdentity)
      : params.fallbackIdentity;
    const externalState: ExternalState | null = confirmed
      ? "normal"
      : proof.status === "diverged"
        ? "modified"
        : // "unverifiable" is not "diverged", and neither is a proof that could not
          // be attributed to this operation: the document's own external state is
          // left exactly as it was, because inventing a conflict out of a failed or
          // unattributeable read-back would be a false positive for Sorakada's own
          // write (FR-015, FR-043, T064).
          null;

    const result = await this.commitSave(
      id,
      generation,
      snapshot,
      adoption,
      externalState,
    );

    if (adoption === null) {
      // No fresh revision describes the bytes Sorakada wrote, so the adopted one is
      // either stale or belongs to content Sorakada did not write. Marking it
      // unknown makes the next validation read the content instead of concluding
      // "unchanged" from metadata that says nothing about the baseline.
      const live = this.sessions.get(id);
      if (live !== undefined) {
        this.forgetAdoptedRevision(live);
      }
    }

    if (confirmed) {
      this.settleMutation(operation, {
        succeeded: true,
        confirmed: [{ comparisonKey: claimKey, exists: true }],
      });
    } else {
      // The operation cannot prove the post-write disk state, so it may not declare
      // its own notifications internal: the guard surfaces every captured hint and
      // the consumer revalidates them against the disk (FR-036).
      this.settleMutation(operation, { succeeded: false, confirmed: [] });
    }

    return result;
  }

  /**
   * Marks the session's adopted revision unknown.
   *
   * Unlike a stale revision, an unknown one makes the next validation read the
   * content instead of concluding "unchanged" from metadata that no longer
   * describes what Sorakada holds.
   */
  private forgetAdoptedRevision(session: DocumentSession): void {
    if (session.pathIdentity !== null) {
      session.pathIdentity = { ...session.pathIdentity, diskRevision: null };
    }
  }

  /**
   * Recreates the bound file of a document whose path is confirmed missing
   * (FR-030–FR-032, FR-045).
   *
   * The original path is reused and only the target file is created: missing
   * ancestor directories are never created, because that would invent a location
   * the user never chose (FR-031).
   */
  private async recreateMissingDocument(
    id: DocumentId,
    binding: DocumentBinding,
  ): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined || !this.isBindingCurrent(binding)) {
      return { status: "success" };
    }

    const targetPath = binding.path;
    const parentPath = parentDirectoryOf(targetPath);
    if (parentPath === null) {
      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `${targetPath} has no parent folder.`,
        ),
      };
    }

    const parent = await this.fileService.inspectDocumentPath(parentPath);
    if (parent.state !== "directory") {
      // FR-031: Save fails and the document stays open and recoverable for
      // Save As, rather than silently creating the missing ancestors.
      return {
        status: "failed",
        error: await this.reportMessage(
          "path_resolution",
          `Cannot recreate ${targetPath}: ${parentPath} is not an existing folder.`,
        ),
      };
    }

    if (!this.isBindingCurrent(binding)) {
      return { status: "success" };
    }

    // FR-045: the target may have reappeared while the parent was being
    // inspected, so its absence is re-confirmed before the recreate write and a
    // reappeared file follows the normal reappearance rules instead of being
    // overwritten as though it were still missing.
    const recheck = await this.diskValidator.validate({
      binding,
      trigger: "reappearance",
      isCurrent: () => this.isBindingCurrent(binding),
    });

    if (recheck.outcome === "stale") {
      return { status: "success" };
    }
    if (recheck.outcome === "missing") {
      // Still absent, so the recreate is the operation to perform — and it creates
      // the target without replacing it (T059), which closes the remaining race.
      return this.writeBoundDocument(id, "recreate");
    }

    return this.applyReappearance(id, binding, recheck);
  }

  /**
   * Handles a target that appeared where a recreate expected absence (FR-045).
   *
   * Nothing has been written by the recreate at this point and the disk content is
   * untouched, so this only has to revalidate and hand the decision to the
   * ordinary reappearance rules.
   */
  private async resolveReappearedTarget(
    id: DocumentId,
    binding: DocumentBinding,
  ): Promise<CommandResult> {
    const validation = await this.diskValidator.validate({
      binding,
      trigger: "reappearance",
      isCurrent: () => this.isBindingCurrent(binding),
    });

    return this.applyReappearance(id, binding, validation);
  }

  /**
   * Applies the reappearance rules for a validation that did not confirm absence.
   *
   * Shared by the pre-write recheck and the create-if-absent race, so a target that
   * reappears is handled identically no matter how late it shows up: a clean
   * document adopts it, a dirty one becomes an explicit conflict, and a real
   * divergence never turns into an overwrite (FR-033, FR-034, FR-045).
   */
  private async applyReappearance(
    id: DocumentId,
    binding: DocumentBinding,
    validation: DiskValidationResult,
  ): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined || !this.isBindingCurrent(binding)) {
      return { status: "success" };
    }

    switch (validation.outcome) {
      case "stale":
        return { status: "success" };
      case "missing":
        // It vanished again between the check and the write, so there is nothing
        // to create and nothing to adopt; reporting is better than looping.
        return {
          status: "failed",
          error: await this.reportMessage(
            "io_write",
            `${binding.path} disappeared before it could be recreated.`,
          ),
        };
      case "unverifiable":
        await this.markValidationError(binding, validation.error);
        return { status: "failed", error: validation.error };
      case "unchanged":
        // The target reappeared holding exactly the state this document already
        // adopted, so there is no external divergence: a dirty document takes the
        // ordinary save path and a clean one has nothing to write.
        if (!session.dirty) {
          return { status: "success" };
        }
        return this.writeBoundDocument(id, "save");
      case "changed":
        return this.resolveSaveDivergence(id, binding, validation);
    }
  }

  /**
   * Reusable guarded Reload-from-Disk entry point (FR-027).
   *
   * 004 exposes no general reload command and 005 deliberately does not add one,
   * so this is the manager operation a future command must go through: it is what
   * makes the dirty-discard confirmation impossible to bypass, and it reuses the
   * same validation and adoption rules as every other disk read.
   */
  async reloadDocumentFromDisk(id: DocumentId): Promise<CommandResult> {
    const session = this.sessions.get(id);
    if (session === undefined || session.path === null) {
      return { status: "success" };
    }

    const binding = this.getBinding(id);
    if (binding === null) {
      return { status: "success" };
    }

    if (session.dirty) {
      // FR-027: disk content may only replace unsaved work after an explicit
      // confirmation; anything else is Cancel and changes nothing.
      const confirmed = await this.dialogs.confirmDiscardForReload(
        session.displayName,
      );
      if (!confirmed) {
        return { status: "cancelled" };
      }
    }

    const validation = await this.diskValidator.validate({
      binding,
      trigger: "reappearance",
      isCurrent: () => this.isBindingCurrent(binding),
    });

    switch (validation.outcome) {
      case "stale":
        return { status: "success" };
      case "unchanged":
        return { status: "success" };
      case "missing": {
        this.markExternalState(binding, "missing");
        return {
          status: "failed",
          error: await this.reportMessage(
            "io_read",
            `${binding.path} no longer exists.`,
          ),
        };
      }
      case "unverifiable": {
        await this.markValidationError(binding, validation.error);
        return { status: "failed", error: validation.error };
      }
      case "changed": {
        this.applyValidatedDiskSnapshot(
          binding,
          { identity: validation.identity, content: validation.content },
          // The discard decision above is exactly the confirmation the forced
          // replacement requires, and it can only have come from the same
          // still-current binding.
          { replaceDirty: true },
        );
        return { status: "success" };
      }
    }
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
    const request: WriteTextFileRequest = {
      path: target,
      text: snapshot.toString(),
      bom: format.bom,
      lineEnding: format.preferredLineEnding,
    };

    // FR-035: the notifications this write produces are reconciled against the
    // post-operation state instead of being mistaken for an outside change.
    const operation = this.internalFsOperations.beginMutation({
      kind: "save-as",
      claims: [{ path: target, comparisonKey: key, effect: "write" }],
    });

    try {
      await this.enqueueWrite(key, request);
    } catch (error) {
      this.settleMutation(operation, { succeeded: false, confirmed: [] });
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
      // operation now owns. Nothing may be declared internal either, because this
      // completion cannot confirm what the newer intent did.
      this.settleMutation(operation, { succeeded: false, confirmed: [] });
      this.releaseClaim(key, id, generation);
      return { status: "success" };
    }

    const result = await this.finishWrite({
      id,
      generation,
      snapshot,
      request,
      operation,
      claimKey: key,
      // A Save As adopts the destination it was told to write even when the
      // read-back cannot prove the bytes yet; the pre-write candidate is the
      // identity the user's choice produced.
      fallbackIdentity: candidate,
    });
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
      request.kind,
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

    // The rename really moved the entry, so the notifications it produced are
    // reconciled against exactly that post-operation state (FR-036): the old
    // path is gone and the new one exists.
    this.reconcileMutationFor(sourceKey, {
      succeeded: true,
      confirmed: [
        { comparisonKey: sourceKey, exists: false },
        { comparisonKey: request.newIdentity.comparisonKey, exists: true },
      ],
    });

    return affected;
  }

  /**
   * Settles the guard claim of the reserved mutation that covers `sourceKey`.
   *
   * A mutation the caller never committed is left alone: its `release` settles it
   * as unsuccessful, which is what makes a cancelled disk operation surface any
   * hints it captured rather than hiding them.
   */
  private reconcileMutationFor(
    sourceKey: string,
    settlement: Parameters<InternalFsOperation["settle"]>[0],
  ): void {
    for (const claim of this.pathMutations.values()) {
      if (claim.sourceKey !== sourceKey || claim.reconciled) {
        continue;
      }
      claim.reconciled = true;
      this.settleMutation(claim.operation, settlement);
      return;
    }
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
      const key = this.sessions.get(id)?.pathIdentity?.comparisonKey;
      this.removeSession(id);
      removed.push(id);

      // A successful internal Delete disposed the path, so the notifications it
      // produced describe a removal the operation itself performed — not an
      // external delete (FR-035). 003's close semantics already ran above.
      if (key !== undefined) {
        this.reconcileMutationFor(key, {
          succeeded: true,
          confirmed: [{ comparisonKey: key, exists: false }],
        });
      }
    }

    return removed;
  }

  /** Points a session at a new path without touching its document state. */
  private applyPath(
    session: DocumentSession,
    path: string,
    identity: ResolvedPathIdentity,
  ): void {
    const previousPath = session.path;
    const previousIdentity = session.pathIdentity;

    session.path = path;
    session.pathIdentity = identity;
    session.displayName = displayNameForPath(path);
    // Every path change advances the binding generation, which is what makes an
    // in-flight validation or reload for the old path stale (FR-039).
    session.bindingGeneration += 1;

    if (previousPath === null || previousIdentity === null) {
      // An Untitled document that just became bound (Save As on a new document):
      // this is its *first* watch interest, so it is a binding and not a
      // migration (FR-002, FR-004).
      this.notifyWatchInterest({
        type: "bound",
        documentId: session.id,
        path,
        identity,
      });
      return;
    }

    if (previousIdentity.comparisonKey !== identity.comparisonKey) {
      this.notifyWatchInterest({
        type: "rebound",
        documentId: session.id,
        previousPath,
        previousIdentity,
        path,
        identity,
      });
    }
  }

  /** Announces a bound-path interest change to the watcher consumer. */
  private notifyWatchInterest(change: WatchInterestChange): void {
    for (const listener of this.watchInterestListeners) {
      listener(change);
    }
  }

  /** Announces a user Tab activation to the watcher consumer (FR-012). */
  private notifyActivation(documentId: DocumentId): void {
    for (const listener of this.activationListeners) {
      listener(documentId);
    }
  }

  /**
   * Settles an internal-operation guard claim and forwards anything the
   * post-operation disk state did not explain.
   *
   * Centralising this is what keeps every internal mutation — Save, Overwrite,
   * recreate, Save As, Explorer Rename and Delete — equally unable to swallow an
   * outside change silently (FR-036).
   */
  private settleMutation(
    operation: InternalFsOperation,
    settlement: Parameters<InternalFsOperation["settle"]>[0],
  ): void {
    const outcome = operation.settle(settlement);
    if (outcome.status !== "diverged" || outcome.unreconciled.length === 0) {
      return;
    }

    for (const listener of this.reconciliationListeners) {
      listener(outcome.unreconciled);
    }
  }

  /**
   * Records a document's external disk state and reports whether it changed.
   *
   * The buffer, `dirty` and the saved baseline are deliberately untouched here:
   * external state is an orthogonal fact (FR-008, FR-009), and a Tab-visible
   * change is what React has to see (FR-041).
   */
  private setExternalState(
    session: DocumentSession,
    state: ExternalState,
  ): boolean {
    if (session.externalState === state) {
      return false;
    }

    session.externalState = state;
    this.emitSnapshot();
    return true;
  }

  /** Allows the next validation failure for a document to be reported again. */
  private forgetValidationError(id: DocumentId): void {
    this.reportedValidationErrors.delete(id);
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
    kind: PathMutationKind,
    sourceKey: string,
    destinationKey: string | null,
  ): PathMutationClaim {
    const id = this.nextPathMutationId;
    this.nextPathMutationId += 1;

    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    // The guard is told what the mutation is expected to do to which canonical
    // path, so the notifications the disk operation produces can be reconciled
    // instead of being mistaken for an outside change (FR-035, FR-036).
    const claims: InternalPathClaim[] = [
      {
        path: sourceKey,
        comparisonKey: sourceKey,
        effect: kind === "create" ? "create" : "remove",
      },
    ];
    if (destinationKey !== null) {
      claims.push({
        path: destinationKey,
        comparisonKey: destinationKey,
        effect: "create",
      });
    }

    const operation = this.internalFsOperations.beginMutation({ kind, claims });

    const claim: PathMutationClaim = {
      id,
      kind,
      sourceKey,
      destinationKey,
      settled,
      reconciled: false,
      operation,
      release: () => {
        // Identity-checked, so a stale release can never drop a newer claim.
        if (this.pathMutations.get(id) === claim) {
          if (!claim.reconciled) {
            // The disk operation never committed, so nothing may be declared
            // internal and every captured hint is handed back for validation.
            claim.reconciled = true;
            this.settleMutation(operation, {
              succeeded: false,
              confirmed: [],
            });
          }
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
   *
   * `externalState` states what the caller proved about the disk after the write:
   * `normal` only for a confirmed write, `modified` when the disk demonstrably
   * holds something else, and `null` when the proof could not be completed — in
   * which case the document's existing external state is left exactly as it was
   * (T060).
   */
  private async commitSave(
    id: DocumentId,
    generation: number,
    snapshot: Text,
    adoption: ResolvedPathIdentity | null,
    externalState: ExternalState | null = "normal",
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
    // A successful write to the bound path is what makes the disk agree with the
    // baseline again, so the external state returns to normal only when the write
    // proved it (FR-017, FR-025, FR-032, T060).
    const externalChanged =
      externalState !== null && session.externalState !== externalState;
    if (externalState !== null) {
      session.externalState = externalState;
    }
    this.forgetValidationError(id);

    if (adoption !== null || dirtyChanged || externalChanged) {
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

    this.applyPath(session, identity.requestedPath, identity);

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
    return this.enqueueWriteOperation(comparisonKey, () =>
      this.fileService.writeTextFile(request),
    );
  }

  /**
   * The create-if-absent counterpart of {@link enqueueWrite} (FR-045, T059).
   *
   * It shares the destination's write chain on purpose: a recreate that raced the
   * same destination's save would otherwise be able to observe "absent" while a
   * queued write was still in flight.
   */
  private enqueueCreate(
    comparisonKey: string,
    request: WriteTextFileRequest,
  ): Promise<void> {
    return this.enqueueWriteOperation(comparisonKey, () =>
      this.fileService.createTextFileIfAbsent(request),
    );
  }

  /** Runs `operation` after every write already queued for `comparisonKey`. */
  private enqueueWriteOperation(
    comparisonKey: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.writeChains.get(comparisonKey);
    // With nothing in flight for this destination the write starts immediately;
    // only an overlapping write has to wait its turn.
    const write =
      previous === undefined
        ? operation()
        : previous.catch(() => undefined).then(() => operation());

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

    // The watch interest is withdrawn before the session disappears, so no
    // subscription can outlive the document it belonged to (FR-003).
    const closing = this.sessions.get(id);
    if (closing?.path != null && closing.pathIdentity !== null) {
      this.notifyWatchInterest({
        type: "unbound",
        documentId: id,
        path: closing.path,
        identity: closing.pathIdentity,
      });
    }
    this.forgetValidationError(id);

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
      // An unbound document has no disk relationship at all, so it can never be
      // `modified` or `missing` until it becomes bound (FR-002).
      externalState: "normal",
      bindingGeneration: 0,
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
      externalState: session.externalState,
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
