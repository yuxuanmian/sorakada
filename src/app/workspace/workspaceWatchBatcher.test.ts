import { describe, expect, it } from "vitest";

import {
  decodeWatchEventPayload,
  type WatchChangeHint,
  type WatchEventPayload,
} from "../../services/filesystemWatcher";
import type { HintScheduler } from "../../services/watchEventNormalizer";
import {
  DEFAULT_WORKSPACE_COALESCE_WINDOW_MS,
  DEFAULT_WORKSPACE_STORM_THRESHOLD,
  WorkspaceWatchBatcher,
  type WorkspaceWatchBatch,
  type WorkspaceWatchBatcherOptions,
} from "./workspaceWatchBatcher";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The exact `change`/`invalidated` JSON `filesystemWatcher.test.ts` and the Rust
 * watcher tests pin, including the two 006 location fields. The payloads below
 * are decoded through the adapter, so a rename of a wire field on either side
 * fails *this* suite too instead of only the adapter's own.
 */
const CHANGE_JSON = {
  type: "change",
  subscriptionId: 7,
  scope: "recursive",
  watchedPath: "C:\\work",
  path: "C:\\work\\src\\a.ts",
  hint: "changed",
  renameTarget: null,
  relativePath: "src\\a.ts",
  renameTargetRelativePath: null,
};

const INVALIDATED_JSON = {
  type: "invalidated",
  scope: "recursive",
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
    relativePath: string | null;
    renameTargetRelativePath: string | null;
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

const A_TS = "C:\\work\\src\\a.ts";
const A_REL = "src\\a.ts";
const B_TS = "C:\\work\\src\\b.ts";
const B_REL = "src\\b.ts";
const OLD_TS = "C:\\work\\src\\old.ts";
const OLD_REL = "src\\old.ts";
const NEW_TS = "C:\\work\\src\\new.ts";
const NEW_REL = "src\\new.ts";

/**
 * Records the window instead of running a real timer: the batcher takes its
 * scheduler as a parameter, so "one window per burst", the delay and the cancel
 * calls are asserted without the suite depending on elapsed time.
 */
class FakeScheduler implements HintScheduler {
  readonly calls: Array<{ handle: number; delayMs: number }> = [];
  readonly cancelled: number[] = [];

  private readonly armed = new Map<number, () => void>();
  /** Every callback, retired ones included, so a late timer can be fired on purpose. */
  private readonly everScheduled: Array<() => void> = [];
  private nextHandle = 1;

  schedule(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.calls.push({ handle, delayMs });
    this.armed.set(handle, callback);
    this.everScheduled.push(callback);
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

  /** Re-runs the callback at `index`, even though the batcher already retired it. */
  fireRetired(index: number): void {
    this.everScheduled[index]();
  }
}

interface Harness {
  batcher: WorkspaceWatchBatcher;
  scheduler: FakeScheduler;
  batches: WorkspaceWatchBatch[];
}

function createHarness(
  options: { windowMs?: number; stormThreshold?: number } = {},
): Harness {
  const scheduler = new FakeScheduler();
  const batches: WorkspaceWatchBatch[] = [];
  const batcherOptions: WorkspaceWatchBatcherOptions = {
    onBatch: (batch) => {
      batches.push(batch);
    },
    scheduler,
  };
  if (options.windowMs !== undefined) {
    batcherOptions.windowMs = options.windowMs;
  }
  if (options.stormThreshold !== undefined) {
    batcherOptions.stormThreshold = options.stormThreshold;
  }

  return { batcher: new WorkspaceWatchBatcher(batcherOptions), scheduler, batches };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchBatcher", () => {
  it("turns one change into one hint with its kind and relative path", () => {
    const { batcher, scheduler, batches } = createHarness();

    batcher.push(change({ path: A_TS, relativePath: A_REL, hint: "created" }));

    // One window for the burst, opened by the first payload and not emitted
    // until it fires: the coordinator must never see a half-collected batch.
    expect(scheduler.calls).toEqual([
      { handle: 1, delayMs: DEFAULT_WORKSPACE_COALESCE_WINDOW_MS },
    ]);
    expect(DEFAULT_WORKSPACE_COALESCE_WINDOW_MS).toBe(100);
    expect(batcher.hasPending()).toBe(true);
    expect(batches).toEqual([]);

    scheduler.fire();

    expect(batches).toEqual([
      {
        rawCount: 1,
        hints: [
          {
            path: A_TS,
            relativePath: A_REL,
            kinds: ["created"],
            renameTarget: null,
            renameTargetRelativePath: null,
          },
        ],
        renameCandidates: [],
        invalidated: false,
        reasons: [],
        requiresRecovery: false,
      },
    ]);
    expect(batcher.hasPending()).toBe(false);
  });

  it("collapses duplicate paths into one hint while counting every payload", () => {
    const { batcher, scheduler, batches } = createHarness();

    const duplicate = change({ path: A_TS, relativePath: A_REL, hint: "changed" });
    batcher.push(duplicate);
    batcher.push(duplicate);
    batcher.push(duplicate);
    batcher.push(change({ path: B_TS, relativePath: B_REL, hint: "changed" }));
    scheduler.fire();

    // Volume stays observable through `rawCount` without being retained, so the
    // coordinator can see a storm without holding a path per event (FR-068).
    expect(batches).toHaveLength(1);
    expect(batches[0].rawCount).toBe(4);
    expect(batches[0].hints).toEqual([
      {
        path: A_TS,
        relativePath: A_REL,
        kinds: ["changed"],
        renameTarget: null,
        renameTargetRelativePath: null,
      },
      {
        path: B_TS,
        relativePath: B_REL,
        kinds: ["changed"],
        renameTarget: null,
        renameTargetRelativePath: null,
      },
    ]);
  });

  it("unions a create+delete burst for one path in first-seen kind order", () => {
    const { batcher, scheduler, batches } = createHarness();

    batcher.push(change({ path: A_TS, relativePath: A_REL, hint: "created" }));
    batcher.push(change({ path: A_TS, relativePath: A_REL, hint: "removed" }));
    scheduler.fire();

    expect(scheduler.calls).toHaveLength(1);
    expect(batches[0].hints).toEqual([
      {
        path: A_TS,
        relativePath: A_REL,
        kinds: ["created", "removed"],
        renameTarget: null,
        renameTargetRelativePath: null,
      },
    ]);
  });

  it("keeps the newest location and rename fields for a repeated path", () => {
    const { batcher, scheduler, batches } = createHarness();

    // The backend can place the same path differently as the burst evolves (a
    // target outside the watch reports a null relative path, for instance), so
    // the coordinator must resolve the path from the last observation.
    batcher.push(
      change({
        path: A_TS,
        relativePath: null,
        hint: "removed",
        renameTarget: NEW_TS,
        renameTargetRelativePath: NEW_REL,
      }),
    );
    batcher.push(
      change({
        path: A_TS,
        relativePath: A_REL,
        hint: "changed",
        renameTarget: null,
      }),
    );
    scheduler.fire();

    expect(batches[0].hints).toEqual([
      {
        path: A_TS,
        relativePath: A_REL,
        kinds: ["removed", "changed"],
        renameTarget: null,
        renameTargetRelativePath: null,
      },
    ]);
    // The pair observed earlier is still a candidate for the window: a later
    // unpaired hint about the source does not retract it.
    expect(batches[0].renameCandidates).toEqual([
      { sourcePath: A_TS, targetPath: NEW_TS },
    ]);
  });

  it("keeps a paired rename as source/target candidates and never as a relocation", () => {
    const { batcher, scheduler, batches } = createHarness();

    batcher.push(
      change({
        path: OLD_TS,
        relativePath: OLD_REL,
        hint: "removed",
        renameTarget: NEW_TS,
        renameTargetRelativePath: NEW_REL,
      }),
    );
    scheduler.fire();

    // The batch carries exactly one hinted path (the source) plus a candidate:
    // nothing here invents a target node, and no field claims the pair is a real
    // rename. The coordinator may use it to narrow an identity match only.
    expect(batches).toEqual([
      {
        rawCount: 1,
        hints: [
          {
            path: OLD_TS,
            relativePath: OLD_REL,
            kinds: ["removed"],
            renameTarget: NEW_TS,
            renameTargetRelativePath: NEW_REL,
          },
        ],
        renameCandidates: [{ sourcePath: OLD_TS, targetPath: NEW_TS }],
        invalidated: false,
        reasons: [],
        requiresRecovery: false,
      },
    ]);
  });

  it("collects a candidate only for a removed or changed path with a target", () => {
    const { batcher, scheduler, batches } = createHarness();

    // A `created` hint cannot be the source half of an observed pair, so it must
    // not become a candidate even when the DTO carries a target.
    batcher.push(
      change({
        path: A_TS,
        relativePath: A_REL,
        hint: "created",
        renameTarget: NEW_TS,
        renameTargetRelativePath: NEW_REL,
      }),
    );
    batcher.push(
      change({
        path: B_TS,
        relativePath: B_REL,
        hint: "changed",
        renameTarget: NEW_TS,
        renameTargetRelativePath: NEW_REL,
      }),
    );
    scheduler.fire();

    expect(batches[0].renameCandidates).toEqual([
      { sourcePath: B_TS, targetPath: NEW_TS },
    ]);
  });

  it("keeps an outside rename target as a raw path only", () => {
    const { batcher, scheduler, batches } = createHarness();

    // `relativePath`/`renameTargetRelativePath` are null for anything outside the
    // watch; the batcher must pass the uncertainty through rather than guess.
    batcher.push(
      change({
        path: "C:\\elsewhere\\moved.ts",
        relativePath: null,
        hint: "removed",
        renameTarget: NEW_TS,
        renameTargetRelativePath: NEW_REL,
      }),
    );
    scheduler.fire();

    expect(batches[0].hints).toEqual([
      {
        path: "C:\\elsewhere\\moved.ts",
        relativePath: null,
        kinds: ["removed"],
        renameTarget: NEW_TS,
        renameTargetRelativePath: NEW_REL,
      },
    ]);
    expect(batches[0].renameCandidates).toEqual([
      { sourcePath: "C:\\elsewhere\\moved.ts", targetPath: NEW_TS },
    ]);
  });

  it("turns an invalidation-only window into a batch with a reason and no hints", () => {
    const { batcher, scheduler, batches } = createHarness();

    // An invalidation has no path, so nothing may gate it on a collected hint: a
    // whole-watch invalidation must still reach the coordinator (FR-069).
    batcher.push(invalidated({ watchedPath: null, reason: "watcher stopped" }));

    expect(scheduler.calls).toHaveLength(1);
    expect(batcher.hasPending()).toBe(true);
    scheduler.fire();

    expect(batches).toEqual([
      {
        rawCount: 1,
        hints: [],
        renameCandidates: [],
        invalidated: true,
        reasons: ["watcher stopped"],
        requiresRecovery: false,
      },
    ]);
  });

  it("joins an open window when invalidation arrives mid-burst", () => {
    const { batcher, scheduler, batches } = createHarness();

    batcher.push(change({ path: A_TS, relativePath: A_REL, hint: "changed" }));
    batcher.push(invalidated({ reason: "overflow" }));
    batcher.push(change({ path: B_TS, relativePath: B_REL, hint: "changed" }));
    scheduler.fire();

    // The invalidation shares the burst's single window instead of opening a
    // second one, and the details collected before it are still reported.
    expect(scheduler.calls).toHaveLength(1);
    expect(batches[0].invalidated).toBe(true);
    expect(batches[0].reasons).toEqual(["overflow"]);
    expect(batches[0].rawCount).toBe(3);
    expect(batches[0].hints.map((hint) => hint.path)).toEqual([A_TS, B_TS]);
  });

  it("deduplicates and bounds invalidation reasons", () => {
    const { batcher, scheduler, batches } = createHarness();

    for (let index = 0; index < 12; index += 1) {
      batcher.push(invalidated({ reason: `reason-${index}` }));
    }
    batcher.push(invalidated({ reason: "reason-0" }));
    scheduler.fire();

    // Reasons are diagnostic detail for a flag that already triggers recovery,
    // so a backend inventing new reasons must not grow the batch.
    expect(batches[0].rawCount).toBe(13);
    expect(batches[0].reasons).toEqual([
      "reason-0",
      "reason-1",
      "reason-2",
      "reason-3",
      "reason-4",
      "reason-5",
      "reason-6",
      "reason-7",
    ]);
  });

  it("retains detail exactly up to the storm threshold and drops it past it", () => {
    const threshold = 8;
    const retained = createHarness({ stormThreshold: threshold });
    for (let index = 0; index < threshold; index += 1) {
      retained.batcher.push(
        change({ path: `C:\\work\\src\\f${index}.ts`, relativePath: `src\\f${index}.ts` }),
      );
    }
    retained.scheduler.fire();

    expect(retained.batches[0].rawCount).toBe(threshold);
    expect(retained.batches[0].requiresRecovery).toBe(false);
    expect(retained.batches[0].hints).toHaveLength(threshold);

    const overflowed = createHarness({ stormThreshold: threshold });
    for (let index = 0; index <= threshold; index += 1) {
      overflowed.batcher.push(
        change({ path: `C:\\work\\src\\f${index}.ts`, relativePath: `src\\f${index}.ts` }),
      );
    }
    overflowed.scheduler.fire();

    // One payload past the budget the whole window switches to recovery: the
    // count keeps rising but no path list survives (FR-069).
    expect(overflowed.batches[0].rawCount).toBe(threshold + 1);
    expect(overflowed.batches[0].requiresRecovery).toBe(true);
    expect(overflowed.batches[0].hints).toEqual([]);
    expect(overflowed.batches[0].renameCandidates).toEqual([]);
  });

  it("keeps a large synthetic burst bounded under the default threshold", () => {
    const { batcher, scheduler, batches } = createHarness();

    expect(DEFAULT_WORKSPACE_STORM_THRESHOLD).toBe(512);
    for (let index = 0; index < 5000; index += 1) {
      batcher.push(
        change({ path: `C:\\work\\src\\f${index}.ts`, relativePath: `src\\f${index}.ts` }),
      );
    }
    scheduler.fire();

    // A `node_modules`-scale burst must not be retained as 5000 paths: the batch
    // remembers the volume and asks for recovery instead (FR-072).
    expect(batches[0].rawCount).toBe(5000);
    expect(batches[0].requiresRecovery).toBe(true);
    expect(batches[0].hints).toEqual([]);
    expect(batches[0].renameCandidates).toEqual([]);
  });

  it("keeps the invalidation flag and reasons while in recovery mode", () => {
    const threshold = 8;
    const { batcher, scheduler, batches } = createHarness({
      stormThreshold: threshold,
    });

    for (let index = 0; index <= threshold; index += 1) {
      batcher.push(change({ path: `C:\\work\\src\\f${index}.ts` }));
    }
    batcher.push(invalidated({ reason: "overflow" }));
    scheduler.fire();

    // Recovery drops path detail, never the two fields that *cause* recovery.
    expect(batches[0].requiresRecovery).toBe(true);
    expect(batches[0].invalidated).toBe(true);
    expect(batches[0].reasons).toEqual(["overflow"]);
    expect(batches[0].hints).toEqual([]);
    expect(batches[0].rawCount).toBe(threshold + 2);
  });

  it("does not restart the window while input keeps arriving", () => {
    const windowMs = 40;
    const { batcher, scheduler, batches } = createHarness({ windowMs });

    for (let index = 0; index < 200; index += 1) {
      batcher.push(
        change({
          path: `C:\\work\\src\\f${index}.ts`,
          relativePath: `src\\f${index}.ts`,
        }),
      );
      // Hints keep accumulating while the window is open, but the deadline stays
      // the one the first payload armed: a restarting debounce could postpone
      // reconciliation forever under a continuous stream.
      expect(scheduler.calls).toEqual([{ handle: 1, delayMs: windowMs }]);
    }
    expect(batches).toEqual([]);

    scheduler.fire();

    expect(batches).toHaveLength(1);
    expect(batches[0].rawCount).toBe(200);
    expect(batches[0].hints).toHaveLength(200);
    // First-seen order is what lets the coordinator walk affected directories
    // deterministically.
    expect(batches[0].hints[0].path).toBe("C:\\work\\src\\f0.ts");
    expect(batches[0].hints[199].path).toBe("C:\\work\\src\\f199.ts");
  });

  it("uses the injected window length when one is configured", () => {
    const { batcher, scheduler } = createHarness({ windowMs: 25 });

    batcher.push(change({ path: A_TS }));

    expect(scheduler.calls).toEqual([{ handle: 1, delayMs: 25 }]);
  });

  it("emits through the scheduler, not through push, for a zero-length window", () => {
    const { batcher, scheduler, batches } = createHarness({ windowMs: 0 });

    batcher.push(change({ path: A_TS, hint: "changed" }));
    batcher.push(change({ path: B_TS, hint: "changed" }));

    // Adjacent pushes still coalesce even with `windowMs: 0`, because the batch
    // is produced by the window callback and only `flush()` may shortcut it.
    expect(scheduler.calls).toEqual([{ handle: 1, delayMs: 0 }]);
    expect(batches).toEqual([]);

    scheduler.fire();

    expect(batches).toHaveLength(1);
    expect(batches[0].hints.map((hint) => hint.path)).toEqual([A_TS, B_TS]);
  });

  it("flushes immediately, cancels the window and never emits the burst twice", () => {
    const { batcher, scheduler, batches } = createHarness();

    batcher.push(change({ path: A_TS, hint: "changed" }));
    batcher.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0].hints.map((hint) => hint.path)).toEqual([A_TS]);
    expect(scheduler.cancelled).toEqual([1]);
    expect(batcher.hasPending()).toBe(false);

    // The retired window must not emit the same burst a second time, and a flush
    // with nothing pending must not fabricate an empty batch.
    scheduler.fireRetired(0);
    scheduler.fire();
    batcher.flush();

    expect(batches).toHaveLength(1);
    expect(scheduler.cancelled).toEqual([1]);
  });

  it("drops pending work on dispose and ignores later pushes", () => {
    const { batcher, scheduler, batches } = createHarness();

    batcher.push(change({ path: A_TS, hint: "changed" }));
    batcher.push(invalidated({ reason: "overflow" }));
    batcher.dispose();

    expect(scheduler.cancelled).toEqual([1]);
    expect(batcher.hasPending()).toBe(false);
    // Disposal is not a flush: the discarded burst is never handed to anyone.
    expect(batches).toEqual([]);

    scheduler.fireRetired(0);
    scheduler.fire();
    batcher.push(change({ path: B_TS, hint: "changed" }));
    batcher.flush();

    expect(batches).toEqual([]);
    expect(scheduler.calls).toHaveLength(1);
  });

  it("is reusable after the window fires", () => {
    const { batcher, scheduler, batches } = createHarness();

    batcher.push(change({ path: A_TS, relativePath: A_REL, hint: "changed" }));
    scheduler.fire();
    batcher.push(change({ path: B_TS, relativePath: B_REL, hint: "removed" }));
    scheduler.fire();

    expect(scheduler.calls).toHaveLength(2);
    // Every window starts clean: the count, the flag set and the candidates
    // belong to one batch and must not leak into the next one.
    expect(batches).toHaveLength(2);
    expect(batches[0].rawCount).toBe(1);
    expect(batches[0].requiresRecovery).toBe(false);
    expect(batches[0].hints.map((hint) => hint.path)).toEqual([A_TS]);
    expect(batches[1].rawCount).toBe(1);
    expect(batches[1].hints.map((hint) => hint.path)).toEqual([B_TS]);
  });
});
