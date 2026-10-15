/**
 * Opened-document consumer of the filesystem watcher (005).
 *
 * This is the one place a filesystem event is allowed to influence a document,
 * and it does so only as a *request for validation*:
 *
 * ```text
 * backend payload
 * → WatchEventNormalizer        (coalesce bursts per interest, carry invalidation)
 * → internalFsOperationGuard    (own-operation hints are reconciled, not trusted)
 * → DiskValidator               (cheap metadata compare, then a read if needed)
 * → DocumentManager transition  (reload / modified / missing / error)
 * ```
 *
 * Two rules shape every method below:
 *
 * 1. **A hint is never a fact** (FR-007). Nothing is applied without a validation
 *    result for a binding that is still current (FR-039).
 * 2. **The consumer is opened documents only** (FR-040). No Workspace rescan, no
 *    Explorer update and no rename/move inference happens here; 006 adds its own
 *    consumer next to this one.
 *
 * Where a document lives is irrelevant to 005: a bound tab outside the active
 * Workspace is watched exactly like one inside it (FR-001).
 */

import type { FileCommandError, ResolvedPathIdentity } from "../../services/fileService";
import type {
  FilesystemWatcherService,
  WatchEventPayload,
  WatchScope,
  WatchSubscriptionHandle,
} from "../../services/filesystemWatcher";
import {
  WatchEventNormalizer,
  type HintScheduler,
  type NormalizedWatchBatch,
  type NormalizedWatchHint,
} from "../../services/watchEventNormalizer";
import type {
  DiskCommitOutcome,
  DocumentBinding,
  ReconciliationListener,
  ValidatedDiskSnapshot,
  WatchInterestChange,
  WatchInterestListener,
  ActivationListener,
} from "./documentManager";
import type { DiskValidationResult, DiskValidationTrigger, DiskValidator } from "./diskValidation";
import type {
  CapturedWatchHint,
  InternalFsOperationGuard,
  InternalHintKind,
} from "./internalFsOperationGuard";
import type { DocumentId, DocumentSession, ExternalState } from "./documentSession";

/**
 * The `DocumentManager` surface this consumer needs.
 *
 * Declared as a narrow port (rather than reaching for the manager class) so the
 * coordinator's own behaviour — coalescing, staleness, own-operation
 * reconciliation — can be tested without a live editor or dialog service.
 */
export interface DocumentWatchPort {
  getSession(id: DocumentId): DocumentSession | undefined;
  listSessions(): readonly DocumentSession[];
  getBinding(id: DocumentId): DocumentBinding | null;
  isBindingCurrent(binding: DocumentBinding): boolean;
  adoptVerifiedIdentity(
    binding: DocumentBinding,
    identity: ResolvedPathIdentity,
  ): boolean;
  applyValidatedDiskSnapshot(
    binding: DocumentBinding,
    snapshot: ValidatedDiskSnapshot,
    options?: { replaceDirty?: boolean },
  ): DiskCommitOutcome;
  markExternalState(binding: DocumentBinding, state: ExternalState): boolean;
  markValidationError(
    binding: DocumentBinding,
    error: FileCommandError,
  ): Promise<boolean>;
  subscribeWatchInterest(listener: WatchInterestListener): () => void;
  subscribeActivation(listener: ActivationListener): () => void;
  subscribeReconciliation(listener: ReconciliationListener): () => void;
}

export interface OpenedDocumentWatchCoordinatorDeps {
  documents: DocumentWatchPort;
  validator: DiskValidator;
  watcher: FilesystemWatcherService;
  /**
   * Shared with `DocumentManager`, so Save/Save As/Rename/Delete notifications
   * and this consumer's hint stream agree on what an own operation is.
   */
  guard: InternalFsOperationGuard;
  /** Coalescing window; 0 in tests. */
  coalesceWindowMs?: number;
  /** Injected timer, so no test depends on real event timing. */
  scheduler?: HintScheduler;
  /**
   * 005 always watches non-recursively through the file's parent directory. The
   * scope stays configurable because the shared backend supports the recursive
   * mode 006's Workspace subscription uses on the same directory.
   */
  scope?: WatchScope;
}

/** One document's watch interest and its in-flight validation state. */
interface Interest {
  documentId: DocumentId;
  path: string;
  canonicalPath: string;
  comparisonKey: string;
  handle: WatchSubscriptionHandle | null;
  /**
   * The start epoch that created this interest (T062).
   *
   * {@link OpenedDocumentWatchCoordinator.dispose} bumps the coordinator's epoch
   * and clears every interest, so an interest whose stamp no longer matches the
   * current epoch belongs to a lifecycle that has been replaced and must never
   * adopt the subscription handle it just obtained.
   */
  epoch: number;
  /**
   * True while a subscription attempt for this interest is in flight.
   *
   * A failed attempt is retried from the cheap triggers, so overlapping retries
   * have to be suppressed rather than stacked.
   */
  subscribing: boolean;
  /**
   * The last validation requested for this interest.
   *
   * Validations for one document run in order, and a newer request retires the
   * older one, so an older reload completion can never overwrite a newer result
   * (T043, FR-039).
   */
  validationChain: Promise<void>;
  validationGeneration: number;
}

/**
 * The lookup key used only as a *fallback* for resolving a hint whose
 * subscription is already gone.
 *
 * It is not an identity system: the authoritative key is the canonical
 * comparison key carried by the interest. Folding case here only ever matches
 * *more* directories than the backend would (an extra, always-safe 005
 * revalidation), never fewer, and the backend's per-directory comparison
 * contract stays the only authority on whether two names can be one entry
 * (T156).
 */
function canonicalLookupKey(canonicalPath: string): string {
  return canonicalPath.toLowerCase();
}

/**
 * The parent directory of a canonical path, as the backend would watch it.
 *
 * 005 subscribes non-recursively through the bound file's parent, so this is the
 * directory an interest would be served by even before its subscription exists.
 * A path with no final component (a volume root) has no parent and only matches
 * itself.
 */
function parentWatchPath(canonicalPath: string): string {
  const trimmed = canonicalPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) {
    return canonicalPath;
  }

  const parent = trimmed.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/**
 * A coalesced hint's kind for the internal-operation guard.
 *
 * A burst that reported several kinds cannot honestly be summarized as one fact,
 * so it is offered as `other`: the guard then refuses to declare it internal and
 * the resulting revalidation decides from the disk instead.
 */
function guardKindFor(hint: NormalizedWatchHint): InternalHintKind {
  return hint.kinds.length === 1 ? hint.kinds[0] : "other";
}

export class OpenedDocumentWatchCoordinator {
  private readonly deps: OpenedDocumentWatchCoordinatorDeps;
  private readonly scope: WatchScope;

  private readonly interests = new Map<DocumentId, Interest>();
  private readonly interestBySubscription = new Map<number, DocumentId>();
  private readonly interestByKey = new Map<string, DocumentId>();
  private readonly interestByCanonicalPath = new Map<string, DocumentId>();

  /**
   * The coalescing normalizer for the current listening session.
   *
   * Recreated by every {@link start} because a disposed normalizer permanently
   * ignores further payloads, and this consumer has to survive a restart.
   */
  private normalizer: WatchEventNormalizer | null = null;

  private unlisten: (() => void) | null = null;
  private readonly disposers: Array<() => void> = [];
  private readonly inFlight = new Set<Promise<void>>();
  private starting: Promise<void> | null = null;
  private disposed = false;

  /**
   * The lifecycle generation of the current listening session (T062).
   *
   * `start()` takes a new value and `dispose()` takes another one, so a run that
   * is still suspended inside an `await` can tell whether it is still the run
   * that owns the coordinator. Without this, a `start()` whose `listen` resolves
   * after a later `start()` has already run would install a second listener set,
   * a second set of manager subscriptions and a second registration sweep into
   * that newer lifecycle (FR-003, FR-039).
   */
  private startEpoch = 0;

  constructor(deps: OpenedDocumentWatchCoordinatorDeps) {
    this.deps = deps;
    this.scope = deps.scope ?? "nonRecursive";
  }

  /**
   * Builds the coalescing normalizer for one listening session.
   *
   * A factory rather than a constructor field, because `start` has to be able to
   * re-arm after a `dispose`.
   */
  private createNormalizer(): WatchEventNormalizer {
    return new WatchEventNormalizer({
      // The subscription is authoritative: the backend already scoped this hint
      // to exactly one watched directory + file, so two subscriptions reporting
      // textually identical paths still group into two distinct interests.
      keyForHint: (hint) => {
        const documentId = this.interestBySubscription.get(hint.subscriptionId);
        if (documentId === undefined) {
          return null;
        }
        return this.interests.get(documentId)?.comparisonKey ?? null;
      },
      // Fallback for a hint whose subscription was already retired — for a Save
      // As / Rename migration the interest's canonical path is what remains.
      keyForPath: (path) => {
        const documentId = this.interestByCanonicalPath.get(
          canonicalLookupKey(path),
        );
        if (documentId === undefined) {
          return null;
        }
        return this.interests.get(documentId)?.comparisonKey ?? null;
      },
      onBatch: (batch) => {
        this.handleBatch(batch);
      },
      ...(this.deps.coalesceWindowMs === undefined
        ? {}
        : { windowMs: this.deps.coalesceWindowMs }),
      ...(this.deps.scheduler === undefined
        ? {}
        : { scheduler: this.deps.scheduler }),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Starts consuming backend payloads and manager interest changes.
   *
   * Idempotent while running (so an overlapping call cannot install two
   * listeners) and **restartable after {@link dispose}**. Restartability is not
   * optional: React Strict Mode mounts, unmounts and mounts again in the desktop
   * shell, so a consumer that stayed dead after its first cleanup would leave the
   * whole application without any filesystem watching at all.
   *
   * Because `listen` and the registration sweep both await, "restartable" also
   * means "generation-safe": each call takes an {@link startEpoch} which
   * {@link dispose} invalidates, so a previous run whose listener resolves late
   * releases that listener and installs nothing (T062, FR-003, FR-039).
   */
  start(): Promise<void> {
    if (this.starting !== null && !this.disposed) {
      return this.starting;
    }

    this.disposed = false;
    this.starting = null;

    // This run's own token. `dispose()` bumps the same field, so every start
    // that is still in flight when the lifecycle changes is invalidated and can
    // only release what it obtained for itself (T062).
    this.startEpoch += 1;
    const epoch = this.startEpoch;

    if (this.normalizer === null) {
      this.normalizer = this.createNormalizer();
    }

    const normalizer = this.normalizer;

    this.starting = this.track(
      (async () => {
        const unlisten = await this.deps.watcher.listen((payload) => {
          // The Workspace consumer shares this channel, and an invalidation is
          // emitted per *logical* scope, so a 006-only loss notice must not turn
          // into a document validation sweep here (plan §2, T058).
          if (this.acceptsPayload(payload)) {
            normalizer.push(payload);
          }
        });
        if (this.isStartSuperseded(epoch) || this.disposed) {
          // The listener arrived for a lifecycle that no longer exists, so it is
          // released here instead of being published as `this.unlisten` — that
          // slot, and every manager subscription, now belongs to the run that
          // replaced this one.
          this.releaseStartListener(unlisten);
          return;
        }
        this.unlisten = unlisten;

        this.disposers.push(
          this.deps.documents.subscribeWatchInterest((change) => {
            this.handleInterestChange(change);
          }),
        );
        this.disposers.push(
          this.deps.documents.subscribeActivation((documentId) => {
            this.validateDocument(documentId, "tab-activate");
          }),
        );
        this.disposers.push(
          this.deps.documents.subscribeReconciliation((hints) => {
            this.handleReconciliation(hints);
          }),
        );

        // Documents can be bound before this consumer was listening (an Open that
        // raced the listener installation), so every already-bound session is
        // registered once. `registerInterest` is idempotent per path.
        for (const session of this.deps.documents.listSessions()) {
          // The sweep awaits once per document, so the epoch is re-checked after
          // every one of them: a superseded run must stop registering into a
          // lifecycle it no longer owns.
          if (this.isStartSuperseded(epoch) || this.disposed) {
            this.releaseStartListener(unlisten);
            return;
          }
          if (session.path !== null && session.pathIdentity !== null) {
            await this.registerInterest({
              type: "bound",
              documentId: session.id,
              path: session.path,
              identity: session.pathIdentity,
            });
          }
        }
      })(),
    );

    return this.starting;
  }

  /**
   * Releases every subscription and listener.
   *
   * Document close and application shutdown both reach the same code path, so a
   * refcounted parent-directory watch is only removed once its last interested
   * document has unsubscribed (FR-003, T047).
   *
   * The consumer stays reusable: {@link start} recreates the normalizer and
   * re-registers every still-bound document, which is what lets the desktop shell
   * survive React Strict Mode's mount/unmount/mount sequence.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.starting = null;

    // Invalidates every start run that is still awaiting its listener or its
    // registration sweep, so none of them can install into a later lifecycle
    // (T062). The run that follows this dispose takes a fresh epoch of its own.
    this.startEpoch += 1;

    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;

    // A disposed normalizer ignores every later payload, so it is discarded
    // rather than reused; `start` builds a fresh one.
    this.normalizer?.dispose();
    this.normalizer = null;

    if (this.unlisten !== null) {
      this.unlisten();
      this.unlisten = null;
    }

    const interests = [...this.interests.values()];
    this.interests.clear();
    this.interestBySubscription.clear();
    this.interestByKey.clear();
    this.interestByCanonicalPath.clear();

    await Promise.all(
      interests.map(async (interest) => {
        if (interest.handle !== null) {
          await interest.handle.stop().catch(() => undefined);
        }
      }),
    );
  }

  /**
   * True once the start run identified by `epoch` is no longer the current one.
   *
   * The authoritative staleness test of this class: every checkpoint that
   * follows an `await` uses it, so a superseded run installs nothing into the
   * lifecycle that replaced it (T062, FR-003, FR-039).
   */
  private isStartSuperseded(epoch: number): boolean {
    return epoch !== this.startEpoch;
  }

  /**
   * Releases the listener a superseded start run obtained for itself.
   *
   * The closure returned by `listen` unregisters exactly this run's listener, so
   * invoking it is always safe. The shared `this.unlisten` slot, by contrast, may
   * already hold the listener of the run that replaced this one and is therefore
   * only cleared while this run is still its owner.
   */
  private releaseStartListener(unlisten: () => void): void {
    unlisten();
    if (this.unlisten === unlisten) {
      this.unlisten = null;
    }
  }

  /**
   * Whether a payload may reach this consumer's normalizer.
   *
   * 005 is interested in two things only: its own change hints (which carry a
   * subscription) and a loss of completeness that could affect a path it watches.
   * 006's recursive Workspace invalidation is *not* one of them unless it names
   * the directory one of this consumer's subscriptions actually watches, so a
   * Workspace-wide overflow no longer forces every opened document to revalidate
   * (FR-010, plan §2).
   */
  private acceptsPayload(payload: WatchEventPayload): boolean {
    if (payload.type !== "invalidated") {
      return true;
    }
    if (payload.watchedPath === null) {
      // A backend-global loss notice names nothing, so every live consumer has to
      // revalidate: 005 included.
      return true;
    }
    if (payload.scope !== "recursive") {
      // A non-recursive notice is this consumer's own scope by construction.
      return true;
    }

    return this.watchesDirectory(payload.watchedPath);
  }

  /**
   * Whether any live interest is served by a backend watch on `watchedPath`.
   *
   * Both sides are Rust-canonical watch directories, and the case folding in
   * [`canonicalLookupKey`] can only widen the match — this is a question about a
   * *subscription* and never a Tree or document path lookup.
   */
  private watchesDirectory(watchedPath: string): boolean {
    const wanted = canonicalLookupKey(watchedPath);

    for (const interest of this.interests.values()) {
      const handlePath = interest.handle?.watchedPath;
      if (
        handlePath !== undefined &&
        canonicalLookupKey(handlePath) === wanted
      ) {
        return true;
      }

      // An interest whose subscription is not established yet (or was refused)
      // still matters: the parent directory of the bound file is exactly the
      // directory 005 would watch for it.
      if (canonicalLookupKey(parentWatchPath(interest.canonicalPath)) === wanted) {
        return true;
      }
    }

    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Validation triggers                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Revalidates one bound document (tab activation, or test/benchmark use).
   */
  validateDocument(
    documentId: DocumentId,
    trigger: DiskValidationTrigger = "tab-activate",
  ): void {
    const interest = this.interests.get(documentId);
    if (interest === undefined || this.disposed) {
      return;
    }
    this.ensureSubscription(interest);
    void this.validateInterest(interest, trigger);
  }

  /**
   * Requests a cheap validation pass over every bound document.
   *
   * Deliberately not `async` and not awaited by the window-focus handler: the
   * focus path must never block on file-content reads (SC-008). Validation itself
   * only reads content when the revision comparison proves the file changed, and
   * it performs at most one inspection per document.
   */
  validateAllOnWindowFocus(): void {
    this.validateAll("window-focus");
  }

  /** How many live backend subscriptions this consumer owns (test seam). */
  activeSubscriptionCount(): number {
    return this.interestBySubscription.size;
  }

  /** Waits until no validation or subscription work is queued (test seam). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Interest registration                                                  */
  /* ---------------------------------------------------------------------- */

  private handleInterestChange(change: WatchInterestChange): void {
    if (this.disposed) {
      return;
    }

    if (change.type === "unbound") {
      const interest = this.interests.get(change.documentId);
      if (interest !== undefined) {
        this.retireInterest(interest);
      }
      return;
    }

    // Registration is asynchronous (it establishes a subscription and then
    // revalidates), so it is tracked: `whenIdle` must not report "done" while a
    // document's interest is still being set up.
    this.track(this.registerInterest(change));
  }

  /**
   * Registers (or migrates) the watch interest of one document.
   *
   * FR-002 is why an Untitled document never reaches this method: the manager only
   * announces interest for a session that already has a disk path.
   */
  private async registerInterest(change: WatchInterestChange): Promise<void> {
    if (this.disposed) {
      return;
    }

    const existing = this.interests.get(change.documentId);

    // 006: a rebound the manager marked as an external relocation must not be
    // trusted as "already validated". The destination's current metadata became
    // the adopted baseline during the rebind, so only a forced snapshot read can
    // tell whether the file still matches what this document holds (FR-061).
    //
    // It is decided *before* the same-comparison-key early return below, because
    // a Windows case-only relocation keeps the key while still changing the bound
    // path (FR-046).
    const relocated =
      change.type === "rebound" && change.cause === "external-relocation";

    if (existing !== undefined) {
      if (existing.comparisonKey === change.identity.comparisonKey && !relocated) {
        // The same document on the same path: the interest is already live (or is
        // being established) and must not be torn down and recreated.
        return;
      }
      // Save As / Rename / relocation migration: the old interest is retired
      // *before* the new one is established, so an event for the old path can no
      // longer reach the document once it is bound elsewhere (FR-004).
      this.retireInterest(existing);
    }

    const interest: Interest = {
      documentId: change.documentId,
      path: change.path,
      canonicalPath: change.identity.canonicalPath,
      comparisonKey: change.identity.comparisonKey,
      handle: null,
      // Stamped with the lifecycle that creates it, so the subscription this
      // registration is about to obtain can never be adopted by a run that has
      // already been superseded (T062).
      epoch: this.startEpoch,
      subscribing: false,
      validationChain: Promise.resolve(),
      validationGeneration: 0,
    };

    this.interests.set(interest.documentId, interest);
    this.interestByKey.set(interest.comparisonKey, interest.documentId);
    this.interestByCanonicalPath.set(
      canonicalLookupKey(interest.canonicalPath),
      interest.documentId,
    );

    await this.establishSubscription(
      interest,
      relocated ? "external-relocation" : "post-subscription",
    );
  }

  private retireInterest(interest: Interest): void {
    if (this.interests.get(interest.documentId) === interest) {
      this.interests.delete(interest.documentId);
    }
    if (this.interestByKey.get(interest.comparisonKey) === interest.documentId) {
      this.interestByKey.delete(interest.comparisonKey);
    }
    const lookup = canonicalLookupKey(interest.canonicalPath);
    if (this.interestByCanonicalPath.get(lookup) === interest.documentId) {
      this.interestByCanonicalPath.delete(lookup);
    }
    if (interest.handle !== null) {
      this.interestBySubscription.delete(interest.handle.subscriptionId);
      void interest.handle.stop().catch(() => undefined);
    }
  }

  private async establishSubscription(
    interest: Interest,
    trigger: DiskValidationTrigger = "post-subscription",
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      const handle = await this.deps.watcher.subscribe(interest.path, this.scope);
      if (
        this.interests.get(interest.documentId) !== interest ||
        interest.epoch !== this.startEpoch ||
        this.disposed
      ) {
        // The document was closed or rebound while the subscription was being
        // established, or the interest was registered by a start run that has
        // since been superseded (T062), so this handle belongs to nobody and
        // must be released rather than adopted by the newer interest (FR-039,
        // T043).
        await handle.stop().catch(() => undefined);
        return;
      }
      interest.handle = handle;
      this.interestBySubscription.set(handle.subscriptionId, interest.documentId);
    } catch {
      // An unwatchable path (a vanished parent, a locked directory) only loses the
      // realtime hint channel. The fallback triggers — activation, window focus and
      // the mandatory pre-save validation — still converge, and no document state
      // may change merely because a subscription failed (FR-015, FR-043).
    }

    // FR-044: without this, a change between the read that produced the baseline
    // and the active subscription would stay invisible forever. After an external
    // relocation the same checkpoint additionally forces a content read (FR-061).
    await this.validateInterest(interest, trigger);
  }

  /* ---------------------------------------------------------------------- */
  /* Hint intake                                                            */
  /* ---------------------------------------------------------------------- */

  private handleBatch(batch: NormalizedWatchBatch): void {
    if (this.disposed) {
      return;
    }

    if (batch.invalidated) {
      // FR-038: an invalidation says the event stream may be incomplete, so it
      // becomes a revalidation request for every interest rather than an
      // assumption that the detailed events said everything. It stays within 005:
      // opened documents are revalidated and no Workspace rescan is triggered
      // (FR-040).
      this.validateAll("watcher-hint");
    }

    for (const hint of batch.hints) {
      if (
        this.deps.guard.capture({
          comparisonKey: hint.comparisonKey,
          path: hint.path,
          kind: guardKindFor(hint),
        })
      ) {
        // An internal operation claimed this path, so the hint is reconciled
        // against that operation's post-write state instead of being validated as
        // an outside change right now (FR-035). Anything the reconciliation cannot
        // explain comes back through `handleReconciliation`.
        continue;
      }

      const interest = this.interestFor(hint.comparisonKey);
      if (interest === undefined) {
        continue;
      }
      void this.validateInterest(interest, "watcher-hint");
    }
  }

  /**
   * Consumes hints an internal operation could not reconcile.
   *
   * This is the half of FR-036 that makes the guard safe to use: a mismatching
   * post-operation disk state is surfaced for validation instead of being
   * suppressed as "probably ours".
   */
  private handleReconciliation(hints: readonly CapturedWatchHint[]): void {
    if (this.disposed) {
      return;
    }

    for (const hint of hints) {
      if (hint.kind === "invalidated") {
        this.validateAll("watcher-hint");
        continue;
      }
      const interest = this.interestFor(hint.comparisonKey);
      if (interest === undefined) {
        continue;
      }
      void this.validateInterest(interest, "watcher-hint");
    }
  }

  private interestFor(comparisonKey: string): Interest | undefined {
    const documentId = this.interestByKey.get(comparisonKey);
    if (documentId === undefined) {
      return undefined;
    }
    return this.interests.get(documentId);
  }

  private validateAll(trigger: DiskValidationTrigger): void {
    for (const interest of [...this.interests.values()]) {
      this.ensureSubscription(interest);
      void this.validateInterest(interest, trigger);
    }
  }

  /**
   * Retries a subscription that could not be established.
   *
   * A path can be unwatchable for reasons that go away — a temporarily locked or
   * unmounted directory is the common one. Without a retry the interest would keep
   * its `handle === null` forever, so that document would be the one document the
   * realtime channel never reaches; the cheap triggers (activation, window focus,
   * invalidation) are exactly the moments where retrying costs nothing.
   */
  private ensureSubscription(interest: Interest): void {
    if (
      this.disposed ||
      interest.handle !== null ||
      interest.subscribing ||
      this.interests.get(interest.documentId) !== interest
    ) {
      return;
    }

    interest.subscribing = true;
    this.track(
      this.establishSubscription(interest).finally(() => {
        interest.subscribing = false;
      }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Validation execution                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Queues one validation for an interest.
   *
   * The generation is bumped synchronously, so an older validation that is still
   * awaiting disk I/O is retired the moment a newer trigger arrives for the same
   * document (T043).
   */
  private validateInterest(
    interest: Interest,
    trigger: DiskValidationTrigger,
  ): Promise<void> {
    const generation = interest.validationGeneration + 1;
    interest.validationGeneration = generation;

    const run = interest.validationChain
      .catch(() => undefined)
      .then(() => this.runValidation(interest, trigger, generation));
    interest.validationChain = run;
    return this.track(run);
  }

  private async runValidation(
    interest: Interest,
    trigger: DiskValidationTrigger,
    generation: number,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.interests.get(interest.documentId) !== interest) {
      return;
    }
    if (generation !== interest.validationGeneration) {
      return;
    }

    const binding = this.deps.documents.getBinding(interest.documentId);
    if (binding === null || binding.comparisonKey !== interest.comparisonKey) {
      return;
    }
    const session = this.deps.documents.getSession(interest.documentId);
    if (session === undefined) {
      return;
    }

    const result = await this.deps.validator.validate({
      binding,
      trigger,
      isCurrent: () => this.deps.documents.isBindingCurrent(binding),
    });

    if (generation !== interest.validationGeneration) {
      // A newer trigger arrived while this one was reading the disk, so its
      // answer describes a state that is no longer the question (FR-039).
      return;
    }

    await this.applyValidation(binding, result);
  }

  private async applyValidation(
    binding: DocumentBinding,
    result: DiskValidationResult,
  ): Promise<void> {
    switch (result.outcome) {
      case "stale":
        // The document was closed or rebound; the newer state owns what happens
        // next. Nothing is applied.
        return;

      case "missing":
        // A confirmed absence keeps the tab, the bound path, the complete
        // in-memory content and the existing dirty state, and only records the
        // state (FR-028, FR-029). The 003 internal-Delete pathway is deliberately
        // not invoked: an external delete is not a Sorakada delete.
        this.deps.documents.markExternalState(binding, "missing");
        return;

      case "unverifiable":
        // A transient read/inspection failure is surfaced without touching the
        // buffer, and it must never become `missing` (FR-015, FR-043).
        await this.deps.documents.markValidationError(binding, result.error);
        return;

      case "unchanged":
        this.deps.documents.adoptVerifiedIdentity(binding, result.identity);
        return;

      case "changed":
        // The manager decides what the snapshot means: a clean document adopts the
        // disk version (FR-016) while a dirty one keeps its buffer, compares the
        // snapshot with its own baseline, and becomes `modified` only for a real
        // text/format divergence rather than for a metadata-only touch (FR-021,
        // FR-022, T061).
        this.deps.documents.applyValidatedDiskSnapshot(binding, {
          identity: result.identity,
          content: result.content,
        });
        return;
    }
  }

  /** Tracks a promise so `whenIdle` can observe it. */
  private track(run: Promise<void>): Promise<void> {
    let tracked: Promise<void>;
    tracked = run
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
    return tracked;
  }
}
