import { describe, expect, it } from "vitest";

import {
  decodeWatchEventPayload,
  type WatchChangeHint,
  type WatchEvent,
  type WatchEventPayload,
} from "./filesystemWatcher";
import {
  DEFAULT_COALESCE_WINDOW_MS,
  WatchEventNormalizer,
  type HintScheduler,
  type NormalizedWatchBatch,
  type WatchEventNormalizerOptions,
} from "./watchEventNormalizer";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The exact `change`/`invalidated` JSON `filesystemWatcher.test.ts` and the Rust
 * watcher tests pin. The payloads below are decoded through the adapter, so a
 * rename of a wire field on either side fails *this* suite too instead of only
 * the adapter's own.
 */
const CHANGE_JSON = {
  type: "change",
  subscriptionId: 7,
  scope: "nonRecursive",
  watchedPath: "C:\\work",
  path: "C:\\work\\notes.txt",
  hint: "changed",
  renameTarget: null,
};

const INVALIDATED_JSON = {
  type: "invalidated",
  scope: "nonRecursive",
  watchedPath: "C:\\work",
  reason: "overflow",
};

/** Decodes one raw payload exactly as the adapter would hand it to a consumer. */
function decoded(raw: unknown): WatchEventPayload {
  const payload = decodeWatchEventPayload(raw);
  if (payload === null) {
    throw new Error(`Not a decodable payload: ${JSON.stringify(raw)}`);
  }
  return payload;
}

function change(
  overrides: Partial<{
    path: string;
    hint: WatchChangeHint;
    renameTarget: string | null;
    subscriptionId: number;
  }> = {},
): WatchEventPayload {
  return decoded({ ...CHANGE_JSON, ...overrides });
}

function invalidated(
  overrides: Partial<{ watchedPath: string | null; reason: string }> = {},
): WatchEventPayload {
  return decoded({ ...INVALIDATED_JSON, ...overrides });
}

/** The two registered interests this suite watches. */
const NOTES_TXT = "C:\\work\\notes.txt";
const NOTES_UPPER = "C:\\work\\NOTES.TXT";
const OTHER_TXT = "C:\\work\\other.txt";

/**
 * The consumer-owned mapping under test: two spellings of one canonical file
 * share a comparison key, and anything else is not registered.
 */
function keyForPath(path: string): string | null {
  if (path === NOTES_TXT || path === NOTES_UPPER) {
    return "notes";
  }
  if (path === OTHER_TXT) {
    return "other";
  }
  return null;
}

/**
 * Records the window instead of running a real timer: the normalizer takes its
 * scheduler as a parameter, so "one window per burst", the delay and the cancel
 * calls are asserted without the suite depending on elapsed time.
 */
class FakeScheduler implements HintScheduler {
  readonly calls: Array<{ handle: number; delayMs: number }> = [];
  readonly cancelled: number[] = [];

  private readonly armed = new Map<number, () => void>();
  private nextHandle = 1;

  schedule(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.calls.push({ handle, delayMs });
    this.armed.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.armed.delete(handle);
  }

  /** Runs every timer still armed, oldest first, as the event loop would. */
  fire(): void {
    const callbacks = [...this.armed.values()];
    this.armed.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

interface Harness {
  normalizer: WatchEventNormalizer;
  scheduler: FakeScheduler;
  batches: NormalizedWatchBatch[];
}

function createHarness(
  windowMs?: number,
  keyForHint?: (hint: WatchEvent) => string | null,
): Harness {
  const scheduler = new FakeScheduler();
  const batches: NormalizedWatchBatch[] = [];
  const options: WatchEventNormalizerOptions = {
    keyForPath,
    onBatch: (batch) => {
      batches.push(batch);
    },
    scheduler,
  };
  if (windowMs !== undefined) {
    options.windowMs = windowMs;
  }
  if (keyForHint !== undefined) {
    options.keyForHint = keyForHint;
  }

  return { normalizer: new WatchEventNormalizer(options), scheduler, batches };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("WatchEventNormalizer", () => {
  it("ignores a change for a path no registered interest cares about", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: "C:\\work\\unrelated.txt" }));

    // Ignoring means ignoring completely: an unrelated hint must not open a
    // window, because that would delay the next real validation for no reason.
    expect(batches).toEqual([]);
    expect(scheduler.calls).toEqual([]);
    expect(normalizer.hasPending()).toBe(false);
  });

  it("coalesces a burst for one interest and keeps first-seen kind order with the newest path", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    normalizer.push(change({ path: NOTES_UPPER, hint: "changed" }));
    normalizer.push(change({ path: NOTES_UPPER, hint: "removed" }));

    // One window for the whole burst, and it is *not* restarted by later
    // payloads: a stream of events can never postpone validation forever.
    expect(scheduler.calls).toEqual([
      { handle: 1, delayMs: DEFAULT_COALESCE_WINDOW_MS },
    ]);
    expect(DEFAULT_COALESCE_WINDOW_MS).toBe(100);
    expect(normalizer.hasPending()).toBe(true);
    expect(batches).toEqual([]);

    scheduler.fire();

    expect(batches).toEqual([
      {
        hints: [
          {
            comparisonKey: "notes",
            path: NOTES_UPPER,
            kinds: ["changed", "removed"],
          },
        ],
        invalidated: false,
      },
    ]);
    expect(normalizer.hasPending()).toBe(false);
  });

  it("keeps two interests in one batch", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    normalizer.push(change({ path: OTHER_TXT, hint: "created" }));
    scheduler.fire();

    expect(scheduler.calls).toHaveLength(1);
    expect(batches).toEqual([
      {
        hints: [
          { comparisonKey: "notes", path: NOTES_TXT, kinds: ["changed"] },
          { comparisonKey: "other", path: OTHER_TXT, kinds: ["created"] },
        ],
        invalidated: false,
      },
    ]);
  });

  it("collapses duplicate identical payloads into one hint with one kind", () => {
    const { normalizer, scheduler, batches } = createHarness();

    const duplicate = change({ path: NOTES_TXT, hint: "changed" });
    normalizer.push(duplicate);
    normalizer.push(duplicate);
    normalizer.push(duplicate);
    scheduler.fire();

    expect(scheduler.calls).toHaveLength(1);
    expect(batches).toEqual([
      {
        hints: [
          { comparisonKey: "notes", path: NOTES_TXT, kinds: ["changed"] },
        ],
        invalidated: false,
      },
    ]);
  });

  it("turns an invalidation with no hints into a revalidation request", () => {
    const { normalizer, scheduler, batches } = createHarness();

    // A whole-backend invalidation has no path at all, so nothing may gate it on
    // having collected a hint first (FR-038).
    normalizer.push(invalidated({ watchedPath: null, reason: "watcher stopped" }));

    expect(scheduler.calls).toHaveLength(1);
    scheduler.fire();

    expect(batches).toEqual([{ hints: [], invalidated: true }]);
  });

  it("joins an open window when invalidation arrives mid-burst", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    normalizer.push(invalidated());
    normalizer.push(change({ path: OTHER_TXT, hint: "changed" }));
    scheduler.fire();

    // The invalidation shares the burst's single window instead of opening a
    // second one, and it still revalidates everything the batch did not mention.
    expect(scheduler.calls).toHaveLength(1);
    expect(batches).toEqual([
      {
        hints: [
          { comparisonKey: "notes", path: NOTES_TXT, kinds: ["changed"] },
          { comparisonKey: "other", path: OTHER_TXT, kinds: ["changed"] },
        ],
        invalidated: true,
      },
    ]);
  });

  it("reports a removed/created pair as two kinds and never as a rename", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(
      change({
        path: NOTES_TXT,
        hint: "removed",
        renameTarget: "C:\\work\\new.txt",
      }),
    );
    normalizer.push(change({ path: NOTES_TXT, hint: "created" }));
    scheduler.fire();

    // 005 must not infer a rename or a move from hints (FR-024), so the batch is
    // pinned to exactly the generic kinds — there is no migration field to drift.
    expect(batches).toEqual([
      {
        hints: [
          {
            comparisonKey: "notes",
            path: NOTES_TXT,
            kinds: ["removed", "created"],
          },
        ],
        invalidated: false,
      },
    ]);
  });

  it("flushes immediately, cancels the window and leaves nothing pending", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    normalizer.flush();

    expect(batches).toHaveLength(1);
    expect(scheduler.cancelled).toEqual([1]);
    expect(normalizer.hasPending()).toBe(false);

    // The retired window must not emit the same burst a second time, and a flush
    // with nothing pending must not fabricate an empty batch.
    scheduler.fire();
    normalizer.flush();

    expect(batches).toHaveLength(1);
    expect(scheduler.cancelled).toEqual([1]);
  });

  it("is reusable after the window fires", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    scheduler.fire();
    normalizer.push(change({ path: OTHER_TXT, hint: "removed" }));
    scheduler.fire();

    expect(scheduler.calls).toHaveLength(2);
    expect(batches).toEqual([
      {
        hints: [
          { comparisonKey: "notes", path: NOTES_TXT, kinds: ["changed"] },
        ],
        invalidated: false,
      },
      {
        hints: [
          { comparisonKey: "other", path: OTHER_TXT, kinds: ["removed"] },
        ],
        invalidated: false,
      },
    ]);
  });

  it("drops pending work on dispose and ignores later pushes", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    normalizer.push(invalidated());
    normalizer.dispose();

    expect(scheduler.cancelled).toEqual([1]);
    expect(normalizer.hasPending()).toBe(false);
    // Disposal is not a flush: the discarded burst is never handed to anyone.
    expect(batches).toEqual([]);

    scheduler.fire();
    normalizer.push(change({ path: OTHER_TXT, hint: "changed" }));
    normalizer.flush();

    expect(batches).toEqual([]);
    expect(scheduler.calls).toHaveLength(1);
  });

  it("emits through the scheduler, not through push, for a zero-length window", () => {
    const { normalizer, scheduler, batches } = createHarness(0);

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    normalizer.push(change({ path: OTHER_TXT, hint: "changed" }));

    // Adjacent pushes still coalesce even with `windowMs: 0`, because the batch
    // is produced by the window callback and only `flush()` may shortcut it.
    expect(scheduler.calls).toEqual([{ handle: 1, delayMs: 0 }]);
    expect(batches).toEqual([]);

    scheduler.fire();

    expect(batches).toEqual([
      {
        hints: [
          { comparisonKey: "notes", path: NOTES_TXT, kinds: ["changed"] },
          { comparisonKey: "other", path: OTHER_TXT, kinds: ["changed"] },
        ],
        invalidated: false,
      },
    ]);
  });

  it("uses the injected window length when one is configured", () => {
    const { normalizer, scheduler } = createHarness(25);

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));

    expect(scheduler.calls).toEqual([{ handle: 1, delayMs: 25 }]);
  });

  /* ---------------------------------------------------------------------- */
  /* Interest identity: subscription first, path only as a fallback          */
  /* ---------------------------------------------------------------------- */

  it("prefers the subscription the hint carries over a contradictory path", () => {
    const seen: WatchEvent[] = [];
    // The path mapping says "notes", the subscription says "other": the
    // subscription is the interest the backend actually watched, so it wins.
    const { normalizer, scheduler, batches } = createHarness(undefined, (hint) => {
      seen.push(hint);
      return "other";
    });

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    scheduler.fire();

    expect(seen).toHaveLength(1);
    expect(seen[0].subscriptionId).toBe(7);
    expect(batches).toEqual([
      {
        hints: [{ comparisonKey: "other", path: NOTES_TXT, kinds: ["changed"] }],
        invalidated: false,
      },
    ]);
  });

  it("falls back to the path when the hint's subscription resolves to nothing", () => {
    const seen: WatchEvent[] = [];
    const { normalizer, scheduler, batches } = createHarness(undefined, (hint) => {
      seen.push(hint);
      // The subscription is no longer registered, so path identity is all that
      // is left to group by.
      return null;
    });

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    scheduler.fire();

    expect(seen).toHaveLength(1);
    expect(batches).toEqual([
      {
        hints: [{ comparisonKey: "notes", path: NOTES_TXT, kinds: ["changed"] }],
        invalidated: false,
      },
    ]);
  });

  it("ignores a hint neither resolver claims, even with a subscription resolver", () => {
    const seen: WatchEvent[] = [];
    const { normalizer, scheduler, batches } = createHarness(undefined, (hint) => {
      seen.push(hint);
      return null;
    });

    normalizer.push(change({ path: "C:\\work\\unrelated.txt", hint: "changed" }));

    // The fallback was consulted, found nothing, and the hint must therefore be
    // dropped completely — no accumulation and no window.
    expect(seen).toHaveLength(1);
    expect(batches).toEqual([]);
    expect(scheduler.calls).toEqual([]);
    expect(normalizer.hasPending()).toBe(false);
  });

  it("never consults a resolver for an invalidation", () => {
    const seen: WatchEvent[] = [];
    const { normalizer, scheduler, batches } = createHarness(undefined, (hint) => {
      seen.push(hint);
      return "notes";
    });

    normalizer.push(invalidated({ reason: "overflow" }));
    scheduler.fire();

    // Invalidation has no subscription and no path to resolve; it revalidates
    // every interest instead (FR-038).
    expect(seen).toEqual([]);
    expect(batches).toEqual([{ hints: [], invalidated: true }]);
  });

  it("keeps the path-based grouping when no subscription resolver is supplied", () => {
    const { normalizer, scheduler, batches } = createHarness();

    normalizer.push(change({ path: NOTES_UPPER, hint: "changed" }));
    normalizer.push(change({ path: OTHER_TXT, hint: "changed" }));
    scheduler.fire();

    expect(batches).toEqual([
      {
        hints: [
          { comparisonKey: "notes", path: NOTES_UPPER, kinds: ["changed"] },
          { comparisonKey: "other", path: OTHER_TXT, kinds: ["changed"] },
        ],
        invalidated: false,
      },
    ]);
  });

  it("separates two subscriptions that report the same path spelling", () => {
    // Two distinct watch interests happen to see the identical path text. No
    // path mapping can tell them apart, which is exactly why the subscription is
    // the authoritative identity (FR-010).
    const keyBySubscription = new Map<number, string>([
      [7, "notes"],
      [8, "mirror"],
    ]);
    const { normalizer, scheduler, batches } = createHarness(
      undefined,
      (hint) => keyBySubscription.get(hint.subscriptionId) ?? null,
    );

    normalizer.push(change({ path: NOTES_TXT, hint: "changed" }));
    normalizer.push(
      change({ path: NOTES_TXT, hint: "removed", subscriptionId: 8 }),
    );
    scheduler.fire();

    expect(scheduler.calls).toHaveLength(1);
    expect(batches).toEqual([
      {
        hints: [
          { comparisonKey: "notes", path: NOTES_TXT, kinds: ["changed"] },
          { comparisonKey: "mirror", path: NOTES_TXT, kinds: ["removed"] },
        ],
        invalidated: false,
      },
    ]);
  });
});
