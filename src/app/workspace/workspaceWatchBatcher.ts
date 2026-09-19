/**
 * Reduces the generic watcher stream into one Workspace-shaped batch per window.
 *
 * Feature 006 watches the Workspace root recursively, so its consumer sees raw
 * hints about files and directories the Explorer *may* represent, while 005 only
 * ever cares about a handful of opened documents. The two consumers therefore
 * cannot share a reducer: `watchEventNormalizer` groups hints by an
 * opened-document comparison key and drops every hint no document claims, which
 * for a Workspace would discard exactly the changes the Tree has to reconcile.
 * This module is a Workspace-specific reducer over the same `WatchEventPayload`
 * DTO, and it deliberately stops at raw path text:
 *
 * - It never mutates Explorer/Tree state, never touches `DocumentManager`, and
 *   never reads the filesystem. It only tells the coordinator what the window
 *   contained so the coordinator can derive affected *represented* directories
 *   (FR-068).
 * - It never maps a path onto the Workspace root. `relativePath` is carried
 *   through verbatim because the backend, not this reducer, knows which watched
 *   directory an event belongs to; the coordinator rebases it under the current
 *   Workspace root, which can differ from the watcher's canonical spelling.
 * - It never proves a rename. A paired `renameTarget` becomes a source/target
 *   *candidate* that the coordinator may use to narrow one ambiguous identity
 *   match, and the batch has no field that could be mistaken for a relocation.
 * - It knows nothing about subscription ids: the coordinator only pushes
 *   payloads that already belong to its own subscription.
 *
 * An `invalidated` payload is not a change at all: the backend is saying its
 * stream may be *incomplete*, so the retained hints cannot be trusted to
 * describe everything that happened. Like 005, an invalidation opens a window on
 * its own (it has no path to wait for) and is reported as a flag plus bounded
 * reasons, which is what makes the coordinator fall back to current filesystem
 * state (FR-069).
 *
 * The window is deliberately non-restarting, exactly as in 005: the first
 * payload opens it and later payloads join it without pushing the deadline out,
 * so a continuous event stream can never postpone reconciliation forever. The
 * window is also the memory bound: a burst that crosses the storm threshold
 * discards its fine-grained detail and says `requiresRecovery` instead, so
 * event volume can never turn into an unbounded path list (FR-069, FR-072).
 */

import type {
  WatchChangeHint,
  WatchEvent,
  WatchEventPayload,
} from "../../services/filesystemWatcher";
import type { HintScheduler } from "../../services/watchEventNormalizer";

/** One unique changed path observed in the window. */
export interface WorkspaceWatchHint {
  /** Raw event path exactly as the backend reported it. */
  path: string;
  /** Subscription-relative path, or null when the event was not inside the watch. */
  relativePath: string | null;
  /** Union of the hints observed for this path, in first-seen order. */
  kinds: readonly WatchChangeHint[];
  /** Raw paired rename destination reported for this path, or null. */
  renameTarget: string | null;
  /** In-watch paired rename destination, or null (an outside target keeps only its raw path). */
  renameTargetRelativePath: string | null;
}

/** One coalesced batch handed to the Workspace coordinator. */
export interface WorkspaceWatchBatch {
  /** How many raw payloads the window observed (bounded by the storm threshold). */
  rawCount: number;
  /** Unique changed paths, in first-seen order; empty once recovery mode took over. */
  hints: WorkspaceWatchHint[];
  /** Paired rename source/target candidates observed in this window. */
  renameCandidates: Array<{ sourcePath: string; targetPath: string | null }>;
  /** True when the backend reported lost completeness during the window. */
  invalidated: boolean;
  /** Deduplicated, bounded invalidation reasons. */
  reasons: string[];
  /** True once the burst exceeded the storm threshold and fine detail was dropped. */
  requiresRecovery: boolean;
}

export interface WorkspaceWatchBatcherOptions {
  onBatch(batch: WorkspaceWatchBatch): void;
  /** Coalescing window in ms; defaults to DEFAULT_WORKSPACE_COALESCE_WINDOW_MS (100). */
  windowMs?: number;
  /** Injected timer; defaults to the global timer functions (same seam as 005). */
  scheduler?: HintScheduler;
  /** Raw-payload budget; defaults to DEFAULT_WORKSPACE_STORM_THRESHOLD (512). */
  stormThreshold?: number;
}

/**
 * How long a Workspace burst is collected before it becomes one reconciliation
 * request.
 *
 * The same 100 ms scale 005 uses: the duplicates and reordered hints one user
 * action produces arrive within a few milliseconds, while a user-visible change
 * should be reflected while it is still the change the user just made. The
 * window is not restarted by later payloads, so the worst case added latency is
 * exactly this value no matter how long the burst lasts (FR-078).
 */
export const DEFAULT_WORKSPACE_COALESCE_WINDOW_MS = 100;

/**
 * How many raw payloads one window may retain fine-grained detail for.
 *
 * A recursive Workspace watch sees `node_modules`-scale bursts where the number
 * of events is unrelated to the number of represented directories. Past this
 * budget the batch switches to recovery mode instead of growing a path list, so
 * the reducer's memory is a constant — never proportional to event volume
 * (FR-069, FR-072).
 */
export const DEFAULT_WORKSPACE_STORM_THRESHOLD = 512;

/**
 * How many distinct invalidation reasons one batch carries.
 *
 * The reasons are diagnostic detail for a recovery that the `invalidated` flag
 * already triggers, so a backend that keeps inventing new reasons must not be
 * able to grow the batch: the first-seen unique reasons are kept and the rest
 * are dropped.
 */
const MAX_INVALIDATION_REASONS = 8;

/**
 * The real timer used when no scheduler is injected.
 *
 * The cast keeps the seam typed as a plain number handle regardless of which
 * environment (webview or Node) declared the global timer functions; nothing
 * outside this module ever looks at the handle.
 */
const globalHintScheduler: HintScheduler = {
  schedule(callback: () => void, delayMs: number): number {
    return setTimeout(callback, delayMs) as unknown as number;
  },
  cancel(handle: number): void {
    clearTimeout(handle);
  },
};

/** One path's accumulated hint, still mutable while its window is open. */
interface PendingWorkspaceHint {
  relativePath: string | null;
  kinds: WatchChangeHint[];
  renameTarget: string | null;
  renameTargetRelativePath: string | null;
}

export class WorkspaceWatchBatcher {
  private readonly onBatch: (batch: WorkspaceWatchBatch) => void;
  private readonly windowMs: number;
  private readonly scheduler: HintScheduler;
  private readonly stormThreshold: number;

  /** Raw path -> accumulated hint, in first-seen path order. */
  private readonly pending = new Map<string, PendingWorkspaceHint>();
  /** Source path -> paired target, in first-seen source order. */
  private readonly renameCandidates = new Map<string, string | null>();
  /** Raw payloads observed in the open window, duplicates included. */
  private rawCount = 0;
  /** Whether an invalidation was observed during the open window. */
  private invalidated = false;
  /** Deduplicated invalidation reasons, bounded by `MAX_INVALIDATION_REASONS`. */
  private reasons: string[] = [];
  /** Whether this window already exceeded the storm threshold. */
  private requiresRecovery = false;
  /** The armed window handle, or `null` when no batch is waiting. */
  private windowHandle: number | null = null;
  /**
   * Identifies the window the armed timer belongs to.
   *
   * A timer that fires after `flush()` or `dispose()` already handed the batch
   * over (or dropped it) must not emit a second, empty batch for a burst that is
   * finished, so the callback proves it is still the current window before it
   * emits anything.
   */
  private windowToken = 0;
  private disposed = false;

  constructor(options: WorkspaceWatchBatcherOptions) {
    this.onBatch = options.onBatch;
    this.windowMs = options.windowMs ?? DEFAULT_WORKSPACE_COALESCE_WINDOW_MS;
    this.scheduler = options.scheduler ?? globalHintScheduler;
    this.stormThreshold =
      options.stormThreshold ?? DEFAULT_WORKSPACE_STORM_THRESHOLD;
  }

  /**
   * Records one payload.
   *
   * The FIRST payload of a burst opens a non-restarting window; every payload
   * arriving before it fires joins the same batch. Everything is counted — an
   * invalidation is part of the window's raw volume too — but a burst that has
   * crossed the storm threshold stops retaining path detail entirely.
   */
  push(payload: WatchEventPayload): void {
    if (this.disposed) {
      return;
    }

    this.rawCount += 1;
    if (this.rawCount > this.stormThreshold) {
      // Crossing the budget drops the detail this payload would have added as
      // well: the coordinator recovers from disk state, so keeping "almost all"
      // of a storm's paths would only reintroduce the unbounded work.
      this.enterRecovery();
    }

    if (payload.type === "invalidated") {
      // Invalidation has no path, so it opens a window on its own: even a burst
      // that consists of nothing but "the stream is no longer trustworthy" has
      // to reach the coordinator as a recovery request. Its reasons survive
      // recovery mode, because they are what explains the recovery.
      this.invalidated = true;
      this.recordReason(payload.reason);
      this.openWindow();
      return;
    }

    if (!this.requiresRecovery) {
      this.accumulate(payload);
    }

    this.openWindow();
  }

  /** Whether a batch is currently waiting for its window. */
  hasPending(): boolean {
    return this.windowHandle !== null;
  }

  /** Emits the pending batch immediately and cancels the window. */
  flush(): void {
    if (this.disposed || this.windowHandle === null) {
      // Nothing is waiting, so there is nothing to hand over: flushing an idle
      // batcher must not fabricate an empty batch for the coordinator.
      return;
    }

    this.scheduler.cancel(this.windowHandle);
    this.windowHandle = null;
    // Retires the armed callback as well, so a timer that already fired (or a
    // scheduler that still holds it) cannot emit this burst a second time.
    this.windowToken += 1;

    const batch = this.takeBatch();
    if (batch !== null) {
      this.onBatch(batch);
    }
  }

  /** Cancels the window and drops pending work; later pushes are ignored. */
  dispose(): void {
    if (this.windowHandle !== null) {
      this.scheduler.cancel(this.windowHandle);
      this.windowHandle = null;
    }
    this.windowToken += 1;
    this.reset();
    this.disposed = true;
  }

  /**
   * Merges one change hint into the window.
   *
   * Raw path text is the grouping identity here, unlike 005: the coordinator
   * only ever pushed payloads from its own recursive subscription, so two
   * spellings of one path cannot belong to two Workspace interests, and the
   * Explorer compares these strings against Tree paths as text anyway.
   */
  private accumulate(hint: WatchEvent): void {
    const existing = this.pending.get(hint.path);
    if (existing === undefined) {
      this.pending.set(hint.path, {
        relativePath: hint.relativePath,
        kinds: [hint.hint],
        renameTarget: hint.renameTarget,
        renameTargetRelativePath: hint.renameTargetRelativePath,
      });
    } else {
      // The union deduplicates and keeps first-seen order. The location and
      // rename fields take the newest observation, including a `null` that says
      // the latest event could no longer place the path inside the watch.
      if (!existing.kinds.includes(hint.hint)) {
        existing.kinds.push(hint.hint);
      }
      existing.relativePath = hint.relativePath;
      existing.renameTarget = hint.renameTarget;
      existing.renameTargetRelativePath = hint.renameTargetRelativePath;
    }

    // Only a removal or a change can be the source half of an observed pair, and
    // only a non-null target makes it a pair at all. This stays a *candidate*:
    // the coordinator may use it to narrow one ambiguous identity match, never
    // as proof that the target is where this source went.
    if (
      (hint.hint === "removed" || hint.hint === "changed") &&
      hint.renameTarget !== null
    ) {
      // The map deduplicates by source path; a newer non-null target replaces an
      // older one, while a later hint that simply carries no target does not
      // withdraw the pair that was observed.
      this.renameCandidates.set(hint.path, hint.renameTarget);
    }
  }

  /** Enters recovery mode: the flag stays, the fine-grained detail goes. */
  private enterRecovery(): void {
    if (this.requiresRecovery) {
      return;
    }

    this.requiresRecovery = true;
    this.pending.clear();
    this.renameCandidates.clear();
  }

  /** Records one invalidation reason once, up to the bounded capacity. */
  private recordReason(reason: string): void {
    if (
      this.reasons.includes(reason) ||
      this.reasons.length >= MAX_INVALIDATION_REASONS
    ) {
      return;
    }

    this.reasons.push(reason);
  }

  /** Arms the window unless one is already open for the current burst. */
  private openWindow(): void {
    if (this.windowHandle !== null) {
      return;
    }

    this.windowToken += 1;
    const token = this.windowToken;
    this.windowHandle = this.scheduler.schedule(
      () => this.emitWindow(token),
      this.windowMs,
    );
  }

  /** The window callback: emits only when its own window is still the current one. */
  private emitWindow(token: number): void {
    if (this.disposed || token !== this.windowToken) {
      return;
    }

    this.windowHandle = null;
    const batch = this.takeBatch();
    if (batch !== null) {
      this.onBatch(batch);
    }
  }

  /**
   * Consumes the accumulated burst.
   *
   * Returns `null` only when there is genuinely nothing to report, which makes a
   * flush of an idle batcher harmless.
   */
  private takeBatch(): WorkspaceWatchBatch | null {
    const rawCount = this.rawCount;
    const invalidated = this.invalidated;
    const reasons = [...this.reasons];
    const requiresRecovery = this.requiresRecovery;

    const hints: WorkspaceWatchHint[] = [];
    for (const [path, hint] of this.pending) {
      hints.push({
        path,
        relativePath: hint.relativePath,
        kinds: [...hint.kinds],
        renameTarget: hint.renameTarget,
        renameTargetRelativePath: hint.renameTargetRelativePath,
      });
    }

    const renameCandidates: Array<{
      sourcePath: string;
      targetPath: string | null;
    }> = [];
    for (const [sourcePath, targetPath] of this.renameCandidates) {
      renameCandidates.push({ sourcePath, targetPath });
    }

    this.reset();

    if (rawCount === 0 && !invalidated) {
      return null;
    }

    return {
      rawCount,
      hints,
      renameCandidates,
      invalidated,
      reasons,
      requiresRecovery,
    };
  }

  /** Clears one window's state so the next burst starts clean. */
  private reset(): void {
    this.pending.clear();
    this.renameCandidates.clear();
    this.rawCount = 0;
    this.invalidated = false;
    this.reasons = [];
    this.requiresRecovery = false;
  }
}
