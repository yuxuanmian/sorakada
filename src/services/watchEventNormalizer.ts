/**
 * Coalesces filesystem watcher payloads into one validation request per window.
 *
 * A watcher is a noisy source. One user-visible change routinely arrives as
 * several duplicated, reordered or coalesced hints, and an atomic
 * write-then-replace on Windows can report a removal for a path that never
 * disappeared. Acting on every payload would validate the same document over and
 * over and, for a dirty document, could raise the same conflict prompt twice for
 * one change (FR-007, FR-011). So hints are grouped per registered interest and
 * handed over at most once per window; the consumer still validates every hint
 * against the current disk state before a document changes, because a hint is
 * never an authoritative state transition.
 *
 * Two identities are deliberately not invented here:
 *
 * - Grouping comes from the caller's `keyForHint`/`keyForPath`, so a hint is
 *   keyed by the same canonical comparison identity the rest of the application
 *   already uses instead of a second, weaker notion of "the same file". Raw path
 *   equality must never become that second identity system (FR-010): two
 *   subscriptions can report textually identical paths and still be two distinct
 *   interests, while one file spelled two ways is still one interest. The caller
 *   owns both mappings for exactly that reason, and `keyForHint` is asked first
 *   because a normalized hint carries the subscription the backend already scoped
 *   to one watched directory + file, which is the authoritative identity of the
 *   interest; `keyForPath` remains the best-effort fallback for a hint whose
 *   subscription is no longer registered.
 * - `renameTarget` is carried by the DTO and never consumed: 005 must not infer a
 *   rename or a move from a hint pair, so a `removed`/`created` sequence for one
 *   interest stays exactly that (FR-024).
 *
 * An `invalidated` payload is not a hint at all: the backend is saying its stream
 * may be *incomplete*, so the detailed events cannot be trusted to describe
 * everything that happened. It becomes a revalidation request for every
 * registered interest (FR-038) rather than an assumption, and it produces a
 * batch even when it is the only thing observed, because a whole-backend
 * invalidation has no path.
 *
 * The window is deliberately non-restarting: the first payload of a burst opens
 * it and every payload arriving before it fires joins the same batch. A
 * restarting debounce would let a continuous stream of events postpone
 * validation forever, which is the opposite of converging on current disk
 * reality.
 */

import type { WatchEvent, WatchEventPayload } from "./filesystemWatcher";

/** The generic change kinds a coalesced hint can carry. */
export type NormalizedHintKind = "created" | "changed" | "removed" | "other";

/** One coalesced hint for one registered interest. */
export interface NormalizedWatchHint {
  /** Comparison key of a registered opened-document interest. */
  comparisonKey: string;
  /** The most recent event path that produced this hint. */
  path: string;
  /** Union of the kinds observed for this interest during the window, in first-seen order. */
  kinds: readonly NormalizedHintKind[];
}

/** One coalesced batch handed to the consumer. */
export interface NormalizedWatchBatch {
  hints: readonly NormalizedWatchHint[];
  /** True when the backend reported invalidation: every registered interest must be revalidated. */
  invalidated: boolean;
}

/** Injected timer so the coalescing window is deterministic in tests. */
export interface HintScheduler {
  schedule(callback: () => void, delayMs: number): number;
  cancel(handle: number): void;
}

export interface WatchEventNormalizerOptions {
  /**
   * Maps an event path to the comparison key of a registered interest, or null
   * when nothing cares about that path.
   *
   * The consumer owns this mapping so path identity keeps using the existing
   * canonical comparison keys instead of inventing a second identity system.
   *
   * This is the *fallback*: it is consulted only when `keyForHint` is absent or
   * cannot resolve the hint's subscription any more.
   */
  keyForPath(path: string): string | null;
  /**
   * Maps one change hint to the comparison key of the interest it belongs to.
   *
   * Takes precedence over `keyForPath` because a normalized hint carries the
   * subscription the backend already scoped it to; `keyForPath` stays the
   * fallback for a hint whose subscription is no longer registered.
   */
  keyForHint?(hint: WatchEvent): string | null;
  /** Receives one coalesced batch per window. */
  onBatch(batch: NormalizedWatchBatch): void;
  /** Coalescing window; defaults to `DEFAULT_COALESCE_WINDOW_MS`. */
  windowMs?: number;
  /** Injected timer; defaults to the global timer functions. */
  scheduler?: HintScheduler;
}

/**
 * How long a burst is collected before it becomes one validation request.
 *
 * 100 ms is the granularity this application needs: the duplicates and reordered
 * hints a single save or edit produces arrive within a few milliseconds (often
 * within the same tick), while a user-visible outside change should be validated
 * while it is still the change the user just made. The window is not restarted by
 * later payloads, so the worst case added latency for a validation is exactly
 * this value no matter how long the burst lasts.
 */
export const DEFAULT_COALESCE_WINDOW_MS = 100;

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

/** One interest's accumulated hints, still mutable while its window is open. */
interface PendingHint {
  path: string;
  kinds: NormalizedHintKind[];
}

export class WatchEventNormalizer {
  private readonly keyForPath: (path: string) => string | null;
  private readonly keyForHint: ((hint: WatchEvent) => string | null) | null;
  private readonly onBatch: (batch: NormalizedWatchBatch) => void;
  private readonly windowMs: number;
  private readonly scheduler: HintScheduler;

  /** comparisonKey -> accumulated hint, in first-seen key order. */
  private readonly pending = new Map<string, PendingHint>();
  /** Whether an invalidation was observed during the open window. */
  private invalidated = false;
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

  constructor(options: WatchEventNormalizerOptions) {
    this.keyForPath = options.keyForPath;
    this.keyForHint = options.keyForHint ?? null;
    this.onBatch = options.onBatch;
    this.windowMs = options.windowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.scheduler = options.scheduler ?? globalHintScheduler;
  }

  /**
   * Records one payload.
   *
   * The FIRST payload of a burst opens a non-restarting window; every payload
   * arriving before it fires joins the same batch. A non-restarting window is
   * used deliberately: a restarting debounce could postpone validation forever
   * under a continuous event stream.
   */
  push(payload: WatchEventPayload): void {
    if (this.disposed) {
      return;
    }

    if (payload.type === "invalidated") {
      // Invalidation has no path, so it opens a window on its own: even a burst
      // that consists of nothing but "the stream is no longer trustworthy" has
      // to reach the consumer as a revalidation request.
      this.invalidated = true;
      this.openWindow();
      return;
    }

    const comparisonKey = this.resolveKey(payload);
    if (comparisonKey === null) {
      // Nothing registered cares about this hint, and it must not open a window
      // either: unrelated activity in the same directory would otherwise delay a
      // real validation by a whole window every time it happened.
      return;
    }

    const existing = this.pending.get(comparisonKey);
    if (existing === undefined) {
      this.pending.set(comparisonKey, {
        path: payload.path,
        kinds: [payload.hint],
      });
    } else {
      // The union deduplicates and keeps first-seen order; the path is replaced
      // by the newest observation so the consumer validates what was last seen.
      if (!existing.kinds.includes(payload.hint)) {
        existing.kinds.push(payload.hint);
      }
      existing.path = payload.path;
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
      // normalizer must not fabricate an empty batch for the consumer.
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
    this.pending.clear();
    this.invalidated = false;
    this.disposed = true;
  }

  /**
   * The comparison key a change hint belongs to.
   *
   * `keyForHint` is asked first because the subscription a hint carries is the
   * interest the backend actually watched; the path is only text, so resolving
   * from it can neither separate two interests that report the same spelling nor
   * be trusted once a subscription has been replaced (FR-010). It stays the
   * fallback so a hint that outlives its subscription is still grouped with the
   * document it evidently concerns.
   */
  private resolveKey(hint: WatchEvent): string | null {
    const bySubscription = this.keyForHint?.(hint) ?? null;
    if (bySubscription !== null) {
      return bySubscription;
    }
    return this.keyForPath(hint.path);
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
   * flush of an idle normalizer harmless.
   */
  private takeBatch(): NormalizedWatchBatch | null {
    const invalidated = this.invalidated;
    const hints: NormalizedWatchHint[] = [];
    for (const [comparisonKey, hint] of this.pending) {
      hints.push({
        comparisonKey,
        path: hint.path,
        kinds: [...hint.kinds],
      });
    }

    this.pending.clear();
    this.invalidated = false;

    if (hints.length === 0 && !invalidated) {
      return null;
    }

    return { hints, invalidated };
  }
}
