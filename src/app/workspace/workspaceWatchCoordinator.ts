/**
 * Workspace consumer of the filesystem watcher (006).
 *
 * This is the second, independent consumer of the same generic hint stream 005
 * uses. It owns Workspace *watching* — subscription lifecycle, event coalescing,
 * storm recovery and periodic fallback — and nothing else:
 *
 * ```text
 * backend payload
 * → subscription/scope filter        (005 document events are not 006's business)
 * → WorkspaceWatchBatcher            (one non-restarting window per burst)
 * → logical-directory mapping        (relativePath rebased under the logical root)
 * → ExplorerController reconciliation (the only place Tree state is applied)
 * → DocumentManager relocation       (only for identity-proven relocations)
 * ```
 *
 * Three rules shape every method below:
 *
 * 1. **A hint is never a structural fact** (FR-013). A watcher event can only
 *    request a one-level reconciliation of a directory the Tree already
 *    represents; it never mutates the Tree itself.
 * 2. **Only represented state is read** (FR-023, FR-072). Never-loaded
 *    directories are not loaded because events happened below them, and recovery
 *    is bounded to the root plus the currently expanded directories.
 * 3. **Every asynchronous continuation proves its generation** (FR-006, FR-100,
 *    FR-112). A replaced/closed Workspace or a rebuilt watcher makes late work
 *    stale rather than dangerous.
 */

import type {
  FilesystemWatcherService,
  WatchEventPayload,
  WatchSubscriptionHandle,
} from "../../services/filesystemWatcher";
import type {
  BatchReconciliationResult,
  DirectoryReconciliationResult,
  ReconciliationSource,
} from "../explorer/explorerController";
import type { ExplorerState } from "../explorer/explorerModel";
import {
  parentDirectoryOf,
  type ConfirmedExplorerRelocation,
  type RenameCandidate,
} from "../explorer/explorerReconciliation";
import type { WorkContext } from "./workContext";
import type { WorkContextSnapshot } from "./workContextManager";
import type {
  ExternalRelocationOutcome,
  ExternalRelocationRequest,
} from "../document/documentManager";
import {
  WorkspaceWatchBatcher,
  type WorkspaceWatchBatch,
  type WorkspaceWatchHint,
} from "./workspaceWatchBatcher";
import { joinPath } from "./workContext";

/**
 * How often the periodic fallback reconciles the root and the expanded area.
 *
 * A watcher can lose events, and an expanded directory link whose target lives
 * outside the root is not covered by the root watch at all, so eventual
 * consistency needs one bounded truth check. Ten seconds is deliberately low
 * frequency: it is a *fallback*, not a polling loop, and it never touches a
 * loaded-but-collapsed directory (FR-073, FR-074).
 */
export const DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS = 10_000;

/**
 * How many directories one drain may reconcile at once.
 *
 * The queue is keyed by logical directory, so a storm can never produce one job
 * per event; this bound additionally keeps a single drain from opening hundreds
 * of concurrent directory reads (FR-106).
 */
const MAX_DIRECTORIES_PER_DRAIN = 16;

/** Injected timers, so no test depends on real time. */
export interface WorkspaceScheduler {
  /** Arms a one-shot timer and returns its handle. */
  schedule(callback: () => void, delayMs: number): number;
  /** Cancels a one-shot timer. */
  cancel(handle: number): void;
  /** Arms a repeating timer; the returned function stops it. */
  repeat(callback: () => void, delayMs: number): () => void;
}

const globalWorkspaceScheduler: WorkspaceScheduler = {
  schedule(callback: () => void, delayMs: number): number {
    return setTimeout(callback, delayMs) as unknown as number;
  },
  cancel(handle: number): void {
    clearTimeout(handle);
  },
  repeat(callback: () => void, delayMs: number): () => void {
    const handle = setInterval(callback, delayMs);
    return () => clearInterval(handle);
  },
};

/** The Explorer surface the coordinator drives (Constitution II: it only asks). */
export interface WorkspaceExplorerPort {
  getState(): ExplorerState;
  /** The represented root path, or `null` while no Workspace is open. */
  getRepresentedRootPath(): string | null;
  /** Whether a logical directory is currently represented. */
  isDirectoryRepresented(path: string): boolean;
  /**
   * Whether a logical directory is represented *and* has been read once.
   *
   * Background work is scheduled against this predicate, never against
   * representation alone: a visible row the user never opened must not be loaded
   * because a watcher event happened below it (FR-023, FR-029).
   */
  isDirectoryRead(path: string): boolean;
  /** Root plus currently expanded represented directories. */
  listExpandedDirectoryPaths(): string[];
  reconcileDirectory(
    path: string,
    source: ReconciliationSource,
    options?: { renameCandidates?: readonly RenameCandidate[] },
  ): Promise<DirectoryReconciliationResult>;
  reconcileDirectories(
    paths: readonly string[],
    source: ReconciliationSource,
    options?: { renameCandidates?: readonly RenameCandidate[] },
  ): Promise<BatchReconciliationResult>;
}

/** The Workspace identity surface the coordinator follows. */
export interface WorkspaceContextPort {
  getContext(): WorkContext | null;
  getSnapshot(): WorkContextSnapshot;
  subscribe(listener: (snapshot: WorkContextSnapshot) => void): () => void;
}

/**
 * The document surface the coordinator uses for confirmed relocations.
 *
 * Deliberately narrow: the coordinator may *request* a relocation, and the
 * manager remains the only thing that may change a document binding.
 */
export interface WorkspaceDocumentPort {
  adoptExternalRelocation(
    request: ExternalRelocationRequest,
  ): Promise<readonly ExternalRelocationOutcome[]>;
}

export interface WorkspaceWatchCoordinatorDeps {
  workContexts: WorkspaceContextPort;
  explorer: WorkspaceExplorerPort;
  documents: WorkspaceDocumentPort;
  watcher: FilesystemWatcherService;
  /** Coalescing window; defaults to the batcher's own default. */
  coalesceWindowMs?: number;
  /** Periodic interval; defaults to `DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS`. */
  periodicIntervalMs?: number;
  /** Storm threshold handed to the batcher. */
  stormThreshold?: number;
  scheduler?: WorkspaceScheduler;
}

/** One pending reconciliation intent for a logical directory. */
interface PendingDirectory {
  source: ReconciliationSource;
  generation: number;
}

/** The stronger of two reconciliation sources (higher wins). */
const SOURCE_PRIORITY: Record<ReconciliationSource, number> = {
  user: 6,
  "manual-refresh": 5,
  watcher: 4,
  "re-expansion": 3,
  recovery: 2,
  periodic: 1,
};

export class WorkspaceWatchCoordinator {
  private readonly deps: WorkspaceWatchCoordinatorDeps;
  private readonly scheduler: WorkspaceScheduler;
  private readonly periodicIntervalMs: number;

  /**
   * The watch lifecycle generation.
   *
   * Every subscription, listener callback, queued reconciliation and timer
   * captures it, and `dispose()`/a WorkContext replacement bumps it, so work
   * from a retired lifecycle can finish but can never commit (FR-006, FR-100).
   */
  private generation = 0;

  private subscription: WatchSubscriptionHandle | null = null;
  private unlisten: (() => void) | null = null;
  private stopPeriodic: (() => void) | null = null;
  private batcher: WorkspaceWatchBatcher | null = null;
  private disposeContextSubscription: (() => void) | null = null;

  private starting: Promise<void> | null = null;
  private disposed = false;

  /** The WorkContext generation the current subscription belongs to. */
  private contextGeneration = -1;

  /**
   * Whether the current lifecycle failed to establish its recursive watch.
   *
   * Degraded mode is *internal*: the Workspace stays usable, periodic
   * reconciliation and Manual Refresh still converge, and a later opportunity
   * retries the subscription — one attempt at a time — so a repaired root is
   * picked up without a retry storm (FR-007, FR-008, FR-099). It never marks the
   * root unavailable; only a failed root read may do that.
   */
  private degraded = false;

  /** Whether a subscription attempt is in flight right now. */
  private subscribing = false;

  /**
   * Identifies the committed WorkContext this coordinator currently serves.
   *
   * Bumped on every retire/replace. A subscription handshake and an open batch
   * window both carry the token they were created under, so work that belongs to
   * a Workspace the user already left can finish but can never install a handle
   * or be applied to the replacement (FR-005, FR-100).
   */
  private contextToken = 0;

  /** Pending reconciliation intents, keyed by logical directory path. */
  private readonly pending = new Map<string, PendingDirectory>();
  private drainScheduled = false;
  private draining = false;
  private periodicRunning = false;

  /** Every reconciliation the coordinator started, so `whenIdle` can observe it. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(deps: WorkspaceWatchCoordinatorDeps) {
    this.deps = deps;
    this.scheduler = deps.scheduler ?? globalWorkspaceScheduler;
    this.periodicIntervalMs =
      deps.periodicIntervalMs ?? DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Starts consuming backend payloads and WorkContext changes.
   *
   * Idempotent while running and restartable after {@link dispose}, because the
   * desktop shell mounts, unmounts and mounts again. A run whose `listen`
   * resolves after a later lifecycle started releases its listener instead of
   * installing into that newer lifecycle.
   */
  start(): Promise<void> {
    if (this.starting !== null && !this.disposed) {
      return this.starting;
    }

    this.disposed = false;
    this.starting = null;
    this.generation += 1;
    const generation = this.generation;

    this.starting = this.track(
      (async () => {
        // The callback resolves the live batcher instead of capturing one: a
        // WorkContext replacement rotates the batcher, and a payload arriving
        // after that must never join a window whose hints belong to the context
        // the user already left (FR-005, FR-100).
        const unlisten = await this.deps.watcher.listen((payload) => {
          this.handlePayload(generation, payload);
        });

        if (generation !== this.generation || this.disposed) {
          unlisten();
          return;
        }
        this.unlisten = unlisten;

        this.disposeContextSubscription = this.deps.workContexts.subscribe(
          (snapshot) => {
            this.handleContextSnapshot(generation, snapshot);
          },
        );

        // Adopt whatever context is already committed; opening a Workspace after
        // this point arrives through the subscription above.
        await this.commitContext(generation, this.deps.workContexts.getContext());
      })(),
    );

    return this.starting;
  }

  /**
   * Releases the subscription, the listener and every timer.
   *
   * Closing a Workspace must not wait for pending directory I/O: invalidating the
   * generation is what makes that work harmless (FR-101, FR-102).
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.starting = null;

    // Invalidated first, so nothing that is already awaiting can commit.
    this.generation += 1;

    this.stopPeriodicTimer();
    this.disposeContextSubscription?.();
    this.disposeContextSubscription = null;

    this.batcher?.dispose();
    this.batcher = null;

    if (this.unlisten !== null) {
      this.unlisten();
      this.unlisten = null;
    }

    const subscription = this.subscription;
    this.subscription = null;
    this.contextGeneration = -1;
    this.pending.clear();

    if (subscription !== null) {
      await subscription.stop().catch(() => undefined);
    }
  }

  /** Waits until no reconciliation the coordinator started is running. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /** Whether realtime Workspace watching is currently degraded (test seam). */
  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Requests a bounded reconciliation of the currently relevant expanded area.
   *
   * Wired to window focus regain (FR-079): the handler must never await disk
   * work, so this only schedules. Work already in flight absorbs the request —
   * a running drain picks the queued paths up, and a running periodic pass
   * already covers exactly the root plus the expanded area — so focus regain can
   * never duplicate a pass (FR-094).
   */
  notifyFocusRegained(): void {
    if (this.disposed) {
      return;
    }

    const generation = this.generation;
    const context = this.deps.workContexts.getContext();
    if (context === null) {
      return;
    }

    // A focus regain is also a cheap opportunity to repair a degraded watcher
    // (FR-099): the root is evidently reachable again if its read succeeds.
    void this.ensureSubscription(generation, context);

    if (this.periodicRunning) {
      // The pass in flight is reconciling the same bounded set.
      return;
    }

    this.enqueue(this.expandedAreaPaths(), "recovery", generation);
  }

  /* ---------------------------------------------------------------------- */
  /* WorkContext handling                                                   */
  /* ---------------------------------------------------------------------- */

  private handleContextSnapshot(
    generation: number,
    snapshot: WorkContextSnapshot,
  ): void {
    if (generation !== this.generation || this.disposed) {
      return;
    }

    if (snapshot.context === null) {
      void this.retireContext();
      return;
    }

    if (snapshot.generation === this.contextGeneration) {
      return;
    }

    void this.commitContext(generation, snapshot.context);
  }

  /**
   * Commits the recursive Workspace watch for one context.
   *
   * A replacement invalidates the previous lifecycle first (stale results can
   * only finish, never commit), then stops the old subscription and timer, then
   * establishes the new one. The batcher is rotated with the context, so an open
   * coalescing window under Workspace A can never be handed to B.
   */
  private async commitContext(
    generation: number,
    context: WorkContext | null,
  ): Promise<void> {
    if (generation !== this.generation || this.disposed) {
      return;
    }

    await this.retireContext();

    if (generation !== this.generation || this.disposed || context === null) {
      return;
    }

    // A fresh batch window owns this context's hints only (FR-005, FR-100).
    this.batcher = this.createBatcher(this.contextToken);

    this.contextGeneration = this.deps.workContexts.getSnapshot().generation;
    this.startPeriodicTimer(generation);

    const started = await this.ensureSubscription(generation, context, this.contextToken);
    if (!started || generation !== this.generation || this.disposed) {
      return;
    }

    // Close the read-then-watch gap: if the Explorer already represents this
    // context, one root reconciliation makes anything that changed between its
    // initial load and the live subscription visible (plan §5). When it does not
    // yet, the normal initial root load is the later authoritative read.
    const representedRoot = this.deps.explorer.getRepresentedRootPath();
    if (representedRoot !== null) {
      this.enqueue([representedRoot], "watcher", generation);
    }
  }

  /**
   * Retires the current subscription, timer and batch window.
   *
   * The context token is bumped first, which is what invalidates a subscription
   * handshake that is still awaiting the backend: it can finish, but it can no
   * longer install itself, and it releases the handle it obtained. Clearing the
   * `subscribing` latch here (rather than leaving it to that abandoned attempt's
   * `finally`) is what lets the replacement context establish its own
   * subscription immediately instead of being refused by a stale in-flight
   * attempt (FR-005, FR-100, SC-007).
   */
  private async retireContext(): Promise<void> {
    this.contextToken += 1;
    this.subscribing = false;

    this.stopPeriodicTimer();
    this.pending.clear();
    this.renameCandidates.length = 0;

    // The open window belongs to the retired context, so it is dropped rather
    // than flushed into the next one.
    this.batcher?.dispose();
    this.batcher = null;

    const subscription = this.subscription;
    this.subscription = null;
    this.contextGeneration = -1;
    this.degraded = false;

    if (subscription !== null) {
      await subscription.stop().catch(() => undefined);
    }
  }

  /**
   * Establishes (or repairs) the recursive root subscription for one context.
   *
   * Returns whether a live subscription exists afterwards. A failure is
   * recorded as internal degraded state and never as root unavailability: the
   * Workspace stays readable and the periodic fallback keeps converging.
   *
   * A later opportunity — a root read, window focus regain, or a periodic tick —
   * may retry, which is what FR-099 asks for. Retrying is bounded by *serialization*
   * rather than by a permanent per-generation veto: only one attempt is ever in
   * flight, and every trigger that arrives meanwhile is absorbed by it, so a
   * permanently broken root cannot turn ticks into a subscription storm.
   *
   * `contextToken` is the identity of the context this attempt serves. A handle
   * that resolves after the Workspace was replaced is stopped instead of being
   * installed, so B never inherits A's watch (FR-005, FR-100).
   */
  private async ensureSubscription(
    generation: number,
    context: WorkContext,
    contextToken: number = this.contextToken,
  ): Promise<boolean> {
    if (generation !== this.generation || this.disposed) {
      return false;
    }
    if (this.subscription !== null) {
      return true;
    }
    if (this.subscribing) {
      return false;
    }

    this.subscribing = true;

    try {
      const handle = await this.deps.watcher.subscribe(
        context.rootPath,
        "recursive",
      );

      if (!this.isAttemptCurrent(generation, contextToken, context)) {
        // The lifecycle or the Workspace was replaced while the subscription was
        // being established, so this handle belongs to nobody.
        await handle.stop().catch(() => undefined);
        return false;
      }

      this.subscription = handle;
      this.degraded = false;
      return true;
    } catch {
      // A failed watch only loses the realtime channel; the Workspace remains
      // open and periodic/manual reconciliation stays authoritative.
      if (this.isAttemptCurrent(generation, contextToken, context)) {
        this.degraded = true;
      }
      return false;
    } finally {
      if (this.contextToken === contextToken) {
        // Only the attempt that still owns the latch may clear it; a retired
        // attempt must not release a newer one's serialization.
        this.subscribing = false;
      }
    }
  }

  /** Whether an in-flight subscription attempt still belongs to the live context. */
  private isAttemptCurrent(
    generation: number,
    contextToken: number,
    context: WorkContext,
  ): boolean {
    if (generation !== this.generation || this.disposed) {
      return false;
    }
    if (contextToken !== this.contextToken) {
      return false;
    }
    return this.deps.workContexts.getContext()?.id === context.id;
  }

  /* ---------------------------------------------------------------------- */
  /* Backend payloads                                                       */
  /* ---------------------------------------------------------------------- */

  private handlePayload(
    generation: number,
    payload: WatchEventPayload,
  ): void {
    if (generation !== this.generation || this.disposed) {
      return;
    }

    if (payload.type === "change") {
      // Ordinary change payloads carry their subscription, so an opened-document
      // event on the shared channel is ignored here instead of becoming
      // Workspace work (plan §1).
      if (payload.subscriptionId !== this.subscription?.subscriptionId) {
        return;
      }
      this.batcher?.push(payload);
      return;
    }

    // An invalidation names no subscription, so scope and path decide: 006
    // accepts only its own recursive root (or a backend-global notice).
    if (!this.invalidationConcernsWorkspace(payload)) {
      return;
    }
    this.batcher?.push(payload);
  }

  /**
   * Whether an invalidation concerns the current recursive Workspace watch.
   *
   * The comparison is between two *watcher* path spellings — the backend's
   * canonical watched directory and the one its invalidation names — so it is a
   * subscription-identity question, not a Tree lookup: Tree paths are only ever
   * reached through the subscription-relative fields (FR-118).
   */
  private invalidationConcernsWorkspace(payload: {
    scope: string;
    watchedPath: string | null;
  }): boolean {
    if (payload.watchedPath === null) {
      // A backend-global loss notice concerns every live consumer.
      return true;
    }
    if (payload.scope !== "recursive") {
      // A non-recursive invalidation belongs to whatever non-recursive interest
      // the backend was serving, which is 005's business.
      return false;
    }

    const watchedPath = this.subscription?.watchedPath;
    if (watchedPath === undefined) {
      return false;
    }

    return sameWatchPath(watchedPath, payload.watchedPath);
  }

  /**
   * Builds the batch window for one committed context.
   *
   * The window's batches are stamped with the context token they were collected
   * under, so a burst that started while Workspace A was active can never be
   * applied to B (FR-005, FR-100).
   */
  private createBatcher(contextToken: number): WorkspaceWatchBatcher {
    return new WorkspaceWatchBatcher({
      onBatch: (batch) => {
        this.handleBatch(this.generation, contextToken, batch);
      },
      ...(this.deps.coalesceWindowMs === undefined
        ? {}
        : { windowMs: this.deps.coalesceWindowMs }),
      ...(this.deps.stormThreshold === undefined
        ? {}
        : { stormThreshold: this.deps.stormThreshold }),
      ...(this.deps.scheduler === undefined
        ? {}
        : { scheduler: this.deps.scheduler }),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Batch → work                                                           */
  /* ---------------------------------------------------------------------- */

  private handleBatch(
    generation: number,
    contextToken: number,
    batch: WorkspaceWatchBatch,
  ): void {
    if (generation !== this.generation || this.disposed) {
      return;
    }
    if (contextToken !== this.contextToken) {
      // The window was opened under a Workspace the user already left.
      return;
    }

    const context = this.deps.workContexts.getContext();
    if (context === null) {
      return;
    }

    if (batch.invalidated || batch.requiresRecovery) {
      // Completeness was lost (or the burst exceeded the fine-grained budget),
      // so the detailed sequence is discarded and recovery reconciles the
      // represented area instead of replaying events (FR-069, FR-070).
      this.scheduleRecovery(generation);
    }

    if (batch.requiresRecovery) {
      return;
    }

    const renameCandidates: RenameCandidate[] = [];
    const targets = new Set<string>();
    const documentOnly: Array<{ oldPath: string; newPath: string }> = [];

    for (const hint of batch.hints) {
      for (const path of this.hintTargets(context, hint)) {
        targets.add(path);
      }

      const source = this.logicalPathFor(context, hint.relativePath);
      const target = this.logicalPathFor(context, hint.renameTargetRelativePath);
      if (source !== null && target !== null) {
        renameCandidates.push({ sourcePath: source, targetPath: target });
      }

      // A paired rename whose destination the Tree does not represent must not be
      // loaded just to preserve Tree continuity. The open-document side may still
      // follow the move, because DocumentManager proves the destination against
      // its own binding rather than trusting the hint (FR-050, FR-051, plan §8).
      const outsideTarget =
        hint.renameTargetRelativePath === null ? hint.renameTarget : null;
      const candidateTarget = target ?? outsideTarget;
      if (source === null || candidateTarget === null) {
        continue;
      }
      const sourceParent = parentDirectoryOf(source);
      if (!this.deps.explorer.isDirectoryRead(sourceParent)) {
        // An event under a never-opened directory creates no work at all.
        continue;
      }
      if (
        target === null ||
        !this.deps.explorer.isDirectoryRead(parentDirectoryOf(target))
      ) {
        documentOnly.push({ oldPath: source, newPath: candidateTarget });
      }
    }

    if (documentOnly.length > 0) {
      // Deliberately not awaited: a document-only proposal is opportunistic and
      // must never delay Tree convergence.
      void this.requestDocumentOnlyRelocations(documentOnly, generation);
    }

    if (targets.size === 0) {
      return;
    }

    this.enqueue([...targets], "watcher", generation, renameCandidates);
  }

  /**
   * Offers paired rename candidates whose destination lies outside the
   * represented Tree to the document lifecycle.
   *
   * 006 never relabels the Explorer *entry* token as a document target identity:
   * it passes paths and `entryObjectIdentity: null`, and DocumentManager
   * independently proves the destination against the binding it already holds.
   * A refusal leaves the document on its previous binding, where 005's missing
   * and conflict rules stay authoritative (FR-063, FR-064, FR-067).
   */
  private async requestDocumentOnlyRelocations(
    candidates: ReadonlyArray<{ oldPath: string; newPath: string }>,
    generation: number,
  ): Promise<void> {
    for (const candidate of candidates) {
      if (generation !== this.generation || this.disposed) {
        return;
      }

      try {
        await this.track(
          this.deps.documents.adoptExternalRelocation({
            oldPath: candidate.oldPath,
            newPath: candidate.newPath,
            // A hint cannot say whether the moved entry was a file or a
            // directory; the manager's containment lookup already covers both.
            kind: "file",
            entryObjectIdentity: null,
          }),
        );
      } catch {
        // A failed proposal is not a structural failure.
      }
    }
  }

  /**
   * The represented logical parents one hint may need reconciled.
   *
   * A hint is mapped back onto the *logical* Workspace root first (never matched
   * as raw text against Tree paths), and only its direct parent is a candidate.
   * The parent must be represented *and already read*, so events below a
   * never-opened directory — a collapsed `node_modules` during an install storm,
   * for instance — create zero background reads (FR-023, FR-029, FR-118). A
   * loaded-but-collapsed directory still qualifies: a direct hint for it is
   * exactly the case FR-075 allows.
   */
  private hintTargets(context: WorkContext, hint: WorkspaceWatchHint): string[] {
    const targets: string[] = [];

    const changed = this.logicalPathFor(context, hint.relativePath);
    if (changed !== null) {
      const parent = parentDirectoryOf(changed);
      if (this.deps.explorer.isDirectoryRead(parent)) {
        targets.push(parent);
      }
    }

    // A paired rename names a second parent that may not have heard anything
    // else: an in-root destination is a Tree candidate, an outside one is only a
    // document-relocation candidate and never an Explorer path (FR-049).
    const renamed = this.logicalPathFor(context, hint.renameTargetRelativePath);
    if (renamed !== null) {
      const parent = parentDirectoryOf(renamed);
      if (this.deps.explorer.isDirectoryRead(parent)) {
        targets.push(parent);
      }
    }

    return targets;
  }

  /** Rebases a subscription-relative path under the logical Workspace root. */
  private logicalPathFor(
    context: WorkContext,
    relativePath: string | null,
  ): string | null {
    if (relativePath === null || relativePath === "") {
      return null;
    }
    return joinPath(context.rootPath, relativePath);
  }

  /* ---------------------------------------------------------------------- */
  /* Bounded scheduling                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * The represented area recovery and focus regain are allowed to touch.
   *
   * The root is always included (a root watcher may not report root-self
   * mutations at all) together with the currently expanded directories. A
   * loaded-but-collapsed directory is deliberately excluded: rereading cached
   * history would recreate the recursive crawler this feature forbids
   * (FR-070, FR-072, FR-074).
   */
  private expandedAreaPaths(): string[] {
    const paths = new Set(this.deps.explorer.listExpandedDirectoryPaths());
    const root = this.deps.explorer.getRepresentedRootPath();
    if (root !== null) {
      paths.add(root);
    }
    return [...paths];
  }

  /**
   * Schedules recovery for the root and the currently expanded area.
   *
   * Recovery is background work: a direct watcher hint for a represented
   * directory outranks it, and it outranks the periodic fallback, which is the
   * priority order FR-070/FR-071 asks for. A still-running drain or periodic
   * pass absorbs the request, so a stream of invalidations cannot stack
   * overlapping sweeps (FR-077, FR-094).
   */
  private scheduleRecovery(generation: number): void {
    if (generation !== this.generation || this.disposed) {
      return;
    }

    this.enqueue(this.expandedAreaPaths(), "recovery", generation);
  }

  /**
   * Adds reconciliation intents to the bounded queue.
   *
   * The queue is keyed by logical directory, so ten thousand hints for one
   * parent produce one pending entry rather than ten thousand jobs, and a
   * stronger intent replaces a weaker one instead of being appended (FR-106).
   */
  private enqueue(
    paths: readonly string[],
    source: ReconciliationSource,
    generation: number,
    renameCandidates: readonly RenameCandidate[] = [],
  ): void {
    if (generation !== this.generation || this.disposed) {
      return;
    }

    for (const rename of renameCandidates) {
      this.renameCandidates.push(rename);
      if (this.renameCandidates.length > MAX_RENAME_CANDIDATES) {
        this.renameCandidates.shift();
      }
    }

    for (const path of paths) {
      const existing = this.pending.get(path);
      if (
        existing === undefined ||
        SOURCE_PRIORITY[source] > SOURCE_PRIORITY[existing.source]
      ) {
        this.pending.set(path, { source, generation });
      }
    }

    this.scheduleDrain(generation);
  }

  private scheduleDrain(generation: number): void {
    if (this.drainScheduled || this.draining) {
      return;
    }
    this.drainScheduled = true;

    // A microtask keeps a synchronous burst of hints (a storm) from opening one
    // read per event: by the time the drain runs, the queue holds unique
    // directories only.
    void Promise.resolve().then(() => {
      this.drainScheduled = false;
      void this.drain(generation);
    });
  }

  /** Drains the queue in bounded batches until nothing is left. */
  private async drain(generation: number): Promise<void> {
    if (this.draining || this.disposed) {
      return;
    }

    this.draining = true;

    try {
      while (generation === this.generation && !this.disposed) {
        const entries = [...this.pending.entries()].sort((left, right) => {
          const rank =
            SOURCE_PRIORITY[right[1].source] - SOURCE_PRIORITY[left[1].source];
          return rank !== 0 ? rank : 0;
        });

        if (entries.length === 0) {
          return;
        }

        const batch = entries.slice(0, MAX_DIRECTORIES_PER_DRAIN);
        for (const [path] of batch) {
          this.pending.delete(path);
        }

        const candidates = [...this.renameCandidates];
        this.renameCandidates.length = 0;

        const run = this.deps.explorer.reconcileDirectories(
          batch.map(([path]) => path),
          batch[0][1].source,
          candidates.length === 0 ? {} : { renameCandidates: candidates },
        );

        const result = await this.track(run);

        if (generation !== this.generation || this.disposed) {
          return;
        }

        await this.applyRelocations(result.relocations, generation);
      }
    } finally {
      this.draining = false;

      // A drain can exit because its generation was replaced (a Workspace close
      // followed by an immediate reopen). `scheduleDrain` refused to start a
      // second drain while this one was still running, so the work queued for the
      // *current* generation would otherwise sit there forever. Handing off here
      // is safe: the exiting drain has just proved it cannot commit, and the
      // queued entries were all enqueued under the current generation (FR-100,
      // FR-101).
      if (!this.disposed && this.pending.size > 0) {
        this.scheduleDrain(this.generation);
      }
    }
  }

  /** Pending paired rename candidates, bounded so a storm cannot grow them. */
  private readonly renameCandidates: RenameCandidate[] = [];

  /* ---------------------------------------------------------------------- */
  /* Relocation → documents                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Requests document adoption for relocations the Explorer proved.
   *
   * The coordinator passes only paths plus the *entry* identity as evidence; the
   * manager derives the expected target identity from its own binding and
   * re-inspects the destination. A rejected relocation never rolls the Explorer
   * back: the Tree already follows the disk, and the document stays subject to
   * 005 validation at its previous path (FR-064, plan §10).
   */
  private async applyRelocations(
    relocations: readonly ConfirmedExplorerRelocation[],
    generation: number,
  ): Promise<void> {
    for (const relocation of relocations) {
      if (generation !== this.generation || this.disposed) {
        return;
      }

      const request: ExternalRelocationRequest = {
        oldPath: relocation.oldPath,
        newPath: relocation.newPath,
        kind: relocation.kind === "directory" ? "directory" : "file",
        entryObjectIdentity: relocation.objectIdentity,
      };

      try {
        await this.deps.documents.adoptExternalRelocation(request);
      } catch {
        // A failed adoption is not a structural failure: the Explorer already
        // reflects disk truth, and 005 remains authoritative for the document.
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Periodic fallback                                                      */
  /* ---------------------------------------------------------------------- */

  private startPeriodicTimer(generation: number): void {
    this.stopPeriodicTimer();

    this.stopPeriodic = this.scheduler.repeat(() => {
      void this.runPeriodicPass(generation);
    }, this.periodicIntervalMs);
  }

  private stopPeriodicTimer(): void {
    this.stopPeriodic?.();
    this.stopPeriodic = null;
  }

  /**
   * One periodic pass over the root and the currently expanded directories.
   *
   * The pass never overlaps itself: while one is running, the next tick is
   * coalesced away rather than stacked (FR-077).
   */
  private async runPeriodicPass(generation: number): Promise<void> {
    if (generation !== this.generation || this.disposed) {
      return;
    }
    if (this.periodicRunning) {
      return;
    }

    this.periodicRunning = true;

    try {
      const context = this.deps.workContexts.getContext();
      if (context === null) {
        return;
      }

      // A periodic pass is a cheap opportunity to repair a degraded watcher
      // (FR-099) without blocking the reconciliation below.
      this.ensureSubscription(generation, context);

      const paths = this.expandedAreaPaths();
      if (paths.length === 0) {
        return;
      }

      const result = await this.track(
        this.deps.explorer.reconcileDirectories(paths, "periodic"),
      );

      if (generation !== this.generation || this.disposed) {
        return;
      }

      await this.applyRelocations(result.relocations, generation);
    } finally {
      this.periodicRunning = false;
    }
  }

  /** Tracks a promise so `whenIdle` can observe it. */
  private track<T>(run: Promise<T>): Promise<T> {
    const tracked = run
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
    return run;
  }
}

/** Upper bound on retained paired rename candidates between drains. */
const MAX_RENAME_CANDIDATES = 64;

/**
 * Whether two watcher path spellings name the same watched directory.
 *
 * Both come from the Rust backend's canonicalization, so this compares two
 * spellings of one *subscription* directory. Folding case here is a deliberate
 * over-approximation in the safe direction — it can only make a completeness
 * notice look relevant (one extra recovery pass) and can never hide one — and it
 * is never a Tree key or a substitute for the backend's per-directory comparison
 * contract (T156).
 */
function sameWatchPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
