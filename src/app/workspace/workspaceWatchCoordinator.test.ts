/**
 * Unit tests for the Workspace filesystem-watch consumer (006).
 *
 * `WorkspaceWatchCoordinator` is the second, independent consumer of the generic
 * watcher hint stream: it owns the recursive root subscription, coalescing,
 * bounded recovery, the periodic fallback and the hand-off of identity-proven
 * relocations to 005. Every dependency is injected, so the whole suite runs on
 * fakes and manual timers — no real clock, no sleeps, no filesystem, no Tauri.
 *
 * The suite is built around the three rules the module states for itself:
 *
 * 1. **A hint is never a structural fact.** It may only ask the Explorer to
 *    reread a directory the Tree already represents.
 * 2. **Only represented state is read.** Events below a never-loaded directory
 *    create no work at all, and recovery never touches a loaded-but-collapsed
 *    directory.
 * 3. **Every asynchronous continuation proves its generation.** A retired
 *    listener, subscription or batch may finish but can never commit.
 */

import { describe, expect, it } from "vitest";

import type {
  FilesystemWatcherService,
  WatchChangeHint,
  WatchEventPayload,
  WatchScope,
  WatchSubscriptionHandle,
} from "../../services/filesystemWatcher";
import type { HintScheduler } from "../../services/watchEventNormalizer";
import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
  WorkspaceEntryKind,
} from "../../services/workspaceFileService";
import { ExplorerController } from "../explorer/explorerController";
import type {
  BatchReconciliationResult,
  DirectoryReconciliationResult,
  ExplorerFileReader,
  ReconciliationSource,
} from "../explorer/explorerController";
import {
  createEmptyExplorerState,
  type ExplorerState,
} from "../explorer/explorerModel";
import type {
  ConfirmedExplorerRelocation,
  RenameCandidate,
} from "../explorer/explorerReconciliation";
import type {
  ExternalRelocationOutcome,
  ExternalRelocationRequest,
} from "../document/documentManager";
import { joinPath, type WorkContext } from "./workContext";
import type { WorkContextSnapshot } from "./workContextManager";
import { DEFAULT_WORKSPACE_STORM_THRESHOLD } from "./workspaceWatchBatcher";
import {
  DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS,
  WorkspaceWatchCoordinator,
  type WorkspaceContextPort,
  type WorkspaceDocumentPort,
  type WorkspaceExplorerPort,
  type WorkspaceScheduler,
  type WorkspaceWatchCoordinatorDeps,
} from "./workspaceWatchCoordinator";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const WORKSPACE_A: WorkContext = {
  id: "workspace-a",
  rootPath: "C:\\work\\root",
  canonicalRootPath: "C:\\work\\root",
  comparisonKey: "c:/work/root",
  displayName: "root",
};

const WORKSPACE_B: WorkContext = {
  id: "workspace-b",
  rootPath: "C:\\other\\tree",
  canonicalRootPath: "C:\\other\\tree",
  comparisonKey: "c:/other/tree",
  displayName: "tree",
};

/** The logical root the user chose (`WorkContext.rootPath`). */
const ROOT = WORKSPACE_A.rootPath;
/** Represented in every fixture below. */
const SRC = joinPath(ROOT, "src");
const LIB = joinPath(ROOT, "lib");
/** Represented (loaded) but *collapsed*: never part of a bounded sweep. */
const COLLAPSED = joinPath(ROOT, "collapsed");
const NODE_MODULES = joinPath(ROOT, "node_modules");

const B_ROOT = WORKSPACE_B.rootPath;
const B_SRC = joinPath(B_ROOT, "src");

/**
 * A canonical `\\?\` spelling of the very same directory.
 *
 * The backend watches a canonicalized directory, which can differ textually from
 * the logical root the user chose; the coordinator may never compare the two as
 * Tree paths (FR-118).
 */
const CANONICAL_ROOT = "\\\\?\\C:\\work\\canonical-root";

/** Injected periodic interval: long enough that only a test can fire it. */
const PERIODIC_INTERVAL_MS = 60_000;

/**
 * The Explorer verbs the coordinator is allowed to reach at all.
 *
 * There is deliberately no "root unavailable" setter in the port: a failed watch
 * is internal degraded state, so the coordinator structurally cannot turn it
 * into the root-unavailable state only a failed root *read* may produce.
 */
const EXPLORER_READ_SURFACE = new Set([
  "getState",
  "getRepresentedRootPath",
  "isDirectoryRepresented",
  "isDirectoryRead",
  "listExpandedDirectoryPaths",
  "reconcileDirectory",
  "reconcileDirectories",
]);

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

type WatchListener = (payload: WatchEventPayload) => void;

/**
 * Records subscriptions and lets a test inject backend payloads.
 *
 * `canonicalize` models the backend's own spelling of a watched directory, so a
 * test can prove that a hint is rebased under the *logical* root rather than
 * matched against the canonical one.
 */
class FakeWatcher implements FilesystemWatcherService {
  /** Every `subscribe` attempt, rejected ones included. */
  readonly subscribeCalls: Array<{ path: string; scope: WatchScope }> = [];
  /** Every subscription id a `stop()` actually released. */
  readonly stopped: number[] = [];
  /** Upcoming `subscribe` calls that reject, modelling an unwatchable root. */
  failSubscribeCount = 0;
  /**
   * Holds every `subscribe` handshake open until `releaseSubscribes()`.
   *
   * This is what models a slow backend handshake racing a Workspace
   * replacement: the attempt was issued for one context but resolves later.
   */
  deferSubscribe = false;
  /** The directory spelling the backend reports for a requested path. */
  canonicalize: (path: string) => string = (path) => path;
  /** How many installed listeners a `stop()`-equivalent actually released. */
  unlistenCalls = 0;

  private readonly liveListeners = new Set<WatchListener>();
  /**
   * Every listener ever installed, released ones included.
   *
   * A backend handshake can still hold a listener the coordinator already
   * dropped, which is exactly the situation the per-lifecycle generation token
   * has to survive.
   */
  private readonly installedListeners: WatchListener[] = [];
  private readonly handles = new Map<number, WatchSubscriptionHandle>();
  private readonly liveSubscriptionIds: number[] = [];
  /** Resolvers of handshakes held open by `deferSubscribe`. */
  private readonly heldHandshakes: Array<() => void> = [];
  private nextId = 1;

  subscribe(path: string, scope: WatchScope): Promise<WatchSubscriptionHandle> {
    this.subscribeCalls.push({ path, scope });
    if (this.failSubscribeCount > 0) {
      this.failSubscribeCount -= 1;
      return Promise.reject(new Error(`Cannot watch ${path}`));
    }

    const handle = this.createHandle(path, scope);

    if (!this.deferSubscribe) {
      return Promise.resolve(handle);
    }

    return new Promise<WatchSubscriptionHandle>((resolve) => {
      this.heldHandshakes.push(() => resolve(handle));
    });
  }

  /** Resolves every held handshake, as a slow backend eventually would. */
  releaseSubscribes(): void {
    const held = [...this.heldHandshakes];
    this.heldHandshakes.length = 0;
    this.deferSubscribe = false;
    for (const resolve of held) {
      resolve();
    }
  }

  /** Whether a subscription id is currently live. */
  isLive(subscriptionId: number): boolean {
    return this.liveSubscriptionIds.includes(subscriptionId);
  }

  private createHandle(path: string, scope: WatchScope): WatchSubscriptionHandle {
    const subscriptionId = this.nextId;
    this.nextId += 1;
    let stopped = false;
    const handle: WatchSubscriptionHandle = {
      subscriptionId,
      path,
      watchedPath: this.canonicalize(path),
      scope,
      stop: () => {
        if (!stopped) {
          stopped = true;
          this.stopped.push(subscriptionId);
          const index = this.liveSubscriptionIds.indexOf(subscriptionId);
          if (index >= 0) {
            this.liveSubscriptionIds.splice(index, 1);
          }
        }
        return Promise.resolve();
      },
    };
    this.handles.set(subscriptionId, handle);
    this.liveSubscriptionIds.push(subscriptionId);
    return handle;
  }

  listen(listener: WatchListener): Promise<() => void> {
    this.liveListeners.add(listener);
    this.installedListeners.push(listener);
    return Promise.resolve(() => {
      if (this.liveListeners.delete(listener)) {
        this.unlistenCalls += 1;
      }
    });
  }

  /** Emits one payload to every *live* listener, as the backend would. */
  emit(payload: WatchEventPayload): void {
    for (const listener of [...this.liveListeners]) {
      listener(payload);
    }
  }

  /**
   * Emits one payload to the listener installed by the n-th `listen` call, even
   * when that listener was already released.
   */
  emitToRetiredListener(index: number, payload: WatchEventPayload): void {
    this.installedListeners[index](payload);
  }

  /** How many listeners are currently installed. */
  listenerCount(): number {
    return this.liveListeners.size;
  }

  /** How many listeners were ever installed. */
  installedCount(): number {
    return this.installedListeners.length;
  }

  /** The id of the newest subscription that is still live. */
  currentSubscriptionId(): number {
    const id = this.liveSubscriptionIds[this.liveSubscriptionIds.length - 1];
    if (id === undefined) {
      throw new Error("No live subscription");
    }
    return id;
  }

  /** Every subscription id that is live right now. */
  liveSubscriptionIdsNow(): number[] {
    return [...this.liveSubscriptionIds];
  }

  /** The directory the backend actually watches for `subscriptionId`. */
  watchedPathOf(subscriptionId: number): string {
    const handle = this.handles.get(subscriptionId);
    if (handle === undefined) {
      throw new Error(`No subscription ${subscriptionId}`);
    }
    return handle.watchedPath;
  }
}

/**
 * Runs one-shot windows and repeating timers on demand.
 *
 * It serves both seams: the batcher's `HintScheduler` (`schedule`/`cancel` for
 * coalescing windows) and the coordinator's `WorkspaceScheduler` (`repeat` for
 * the periodic fallback). No test ever waits on a real timer.
 */
class FakeScheduler implements WorkspaceScheduler, HintScheduler {
  /** Delays of every one-shot window, in the order they were armed. */
  readonly oneShotDelays: number[] = [];
  /** Delays of every repeating timer, in the order it was armed. */
  readonly repeatDelays: number[] = [];
  readonly cancelled: number[] = [];

  private readonly oneShots = new Map<number, () => void>();
  private readonly repeats = new Map<number, () => void>();
  /** Retired repeating callbacks, so a late tick can be fired on purpose. */
  private readonly everRepeated: Array<() => void> = [];
  private nextHandle = 1;

  schedule(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.oneShotDelays.push(delayMs);
    this.oneShots.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.oneShots.delete(handle);
  }

  repeat(callback: () => void, delayMs: number): () => void {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.repeatDelays.push(delayMs);
    this.repeats.set(handle, callback);
    this.everRepeated.push(callback);
    return () => {
      this.repeats.delete(handle);
    };
  }

  /** Fires every armed coalescing window, oldest first. */
  fireWindow(): void {
    const callbacks = [...this.oneShots.values()];
    this.oneShots.clear();
    for (const callback of callbacks) {
      callback();
    }
  }

  /** Fires one periodic tick for every repeating timer still armed. */
  firePeriodic(): void {
    for (const callback of [...this.repeats.values()]) {
      callback();
    }
  }

  /** Fires every repeating callback ever armed, retired ones included. */
  fireRetiredPeriodic(): void {
    for (const callback of [...this.everRepeated]) {
      callback();
    }
  }

  activeRepeatCount(): number {
    return this.repeats.size;
  }

  /** How many coalescing windows were opened in total. */
  windowCount(): number {
    return this.oneShotDelays.length;
  }
}

/** A settable WorkContext with listeners, standing in for the manager. */
class FakeContexts implements WorkspaceContextPort {
  private context: WorkContext | null;
  private generation = 0;
  private readonly listeners = new Set<
    (snapshot: WorkContextSnapshot) => void
  >();

  constructor(context: WorkContext | null) {
    this.context = context;
  }

  getContext(): WorkContext | null {
    return this.context;
  }

  getSnapshot(): WorkContextSnapshot {
    return {
      context: this.context,
      generation: this.generation,
      rootUnavailable: false,
    };
  }

  subscribe(listener: (snapshot: WorkContextSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  /** Commits a replacement/close, exactly as the manager would announce it. */
  commit(context: WorkContext | null): void {
    this.context = context;
    this.generation += 1;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }
}

/** One recorded reconciliation request. */
interface ReconcileCall {
  method: "reconcileDirectory" | "reconcileDirectories";
  paths: string[];
  source: ReconciliationSource;
  options: { renameCandidates?: readonly RenameCandidate[] } | undefined;
}

/** Nothing applied, nothing relocated: the calm answer to a reconciliation. */
const NOTHING_APPLIED: BatchReconciliationResult = {
  applied: false,
  relocations: [],
  directories: [],
};

/**
 * The Explorer surface as a recording/configurable fake.
 *
 * It answers only what a real Explorer would answer — represented root, whether
 * a logical directory is represented, the expanded area — and records every
 * request, so "exactly one reconciliation for this parent" is assertable.
 */
class FakeExplorer implements WorkspaceExplorerPort {
  representedRootPath: string | null = null;
  readonly representedDirectories = new Set<string>();
  /** Represented directories that have really been read at least once. */
  readonly readDirectories = new Set<string>();
  expandedDirectoryPaths: string[] = [];
  readonly calls: ReconcileCall[] = [];
  /** Holds every reconciliation open until `releaseAll()`. */
  holdReconciles = false;

  private readonly queuedResults: BatchReconciliationResult[] = [];
  private readonly heldResolvers: Array<() => void> = [];
  private readonly usedMethods: string[] = [];

  /**
   * Models a loaded Tree.
   *
   * `expanded` directories are the ones a bounded sweep may reread; `collapsed`
   * ones are loaded but closed, and must never be swept (FR-074).
   */
  represent(
    root: string,
    expanded: readonly string[],
    collapsed: readonly string[] = [],
    options: { neverRead?: readonly string[] } = {},
  ): void {
    this.representedRootPath = root;
    this.representedDirectories.add(root);
    for (const path of expanded) {
      this.representedDirectories.add(path);
    }
    for (const path of collapsed) {
      this.representedDirectories.add(path);
    }
    // A row the user never opened is represented without having been read, and a
    // hint below it must produce no background work (FR-023).
    for (const path of options.neverRead ?? []) {
      this.representedDirectories.add(path);
      this.readDirectories.delete(path);
    }
    for (const path of [root, ...expanded, ...collapsed]) {
      if (!(options.neverRead ?? []).includes(path)) {
        this.readDirectories.add(path);
      }
    }
    this.expandedDirectoryPaths = [
      root,
      ...expanded.filter((path) => path !== root),
    ];
  }

  /** Cans the next batch result, in call order. */
  queueResult(result: BatchReconciliationResult): void {
    this.queuedResults.push(result);
  }

  /** Resolves every held reconciliation and lets later ones resolve at once. */
  releaseAll(): void {
    const held = [...this.heldResolvers];
    this.heldResolvers.length = 0;
    this.holdReconciles = false;
    for (const resolve of held) {
      resolve();
    }
  }

  /** How many reconciliations are still open. */
  pendingReads(): number {
    return this.heldResolvers.length;
  }

  /** Every port method name the coordinator used, in call order. */
  methods(): string[] {
    return [...this.usedMethods];
  }

  /* -------- WorkspaceExplorerPort -------- */

  getState(): ExplorerState {
    this.usedMethods.push("getState");
    return createEmptyExplorerState();
  }

  getRepresentedRootPath(): string | null {
    this.usedMethods.push("getRepresentedRootPath");
    return this.representedRootPath;
  }

  isDirectoryRepresented(path: string): boolean {
    this.usedMethods.push("isDirectoryRepresented");
    return this.representedDirectories.has(path);
  }

  isDirectoryRead(path: string): boolean {
    this.usedMethods.push("isDirectoryRead");
    return this.readDirectories.has(path);
  }

  listExpandedDirectoryPaths(): string[] {
    this.usedMethods.push("listExpandedDirectoryPaths");
    return [...this.expandedDirectoryPaths];
  }

  reconcileDirectory(
    path: string,
    source: ReconciliationSource,
    options?: { renameCandidates?: readonly RenameCandidate[] },
  ): Promise<DirectoryReconciliationResult> {
    this.usedMethods.push("reconcileDirectory");
    this.calls.push({
      method: "reconcileDirectory",
      paths: [path],
      source,
      options,
    });
    return Promise.resolve({
      path,
      applied: false,
      relocations: [],
      removedPaths: [],
      addedPaths: [],
    });
  }

  reconcileDirectories(
    paths: readonly string[],
    source: ReconciliationSource,
    options?: { renameCandidates?: readonly RenameCandidate[] },
  ): Promise<BatchReconciliationResult> {
    this.usedMethods.push("reconcileDirectories");
    this.calls.push({
      method: "reconcileDirectories",
      paths: [...paths],
      source,
      options,
    });

    const result = this.queuedResults.shift() ?? NOTHING_APPLIED;
    if (!this.holdReconciles) {
      return Promise.resolve(result);
    }
    return new Promise<BatchReconciliationResult>((resolve) => {
      this.heldResolvers.push(() => resolve(result));
    });
  }
}

/** Records relocation requests and returns canned outcomes. */
class FakeDocuments implements WorkspaceDocumentPort {
  readonly requests: ExternalRelocationRequest[] = [];
  outcomes: readonly ExternalRelocationOutcome[] = [];
  /** Makes the next adoption reject, as an unreadable destination would. */
  failNext = false;

  adoptExternalRelocation(
    request: ExternalRelocationRequest,
  ): Promise<readonly ExternalRelocationOutcome[]> {
    // Copied, so a later mutation cannot rewrite what was actually asked.
    this.requests.push({ ...request });
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("destination unavailable"));
    }
    return Promise.resolve(this.outcomes);
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  coordinator: WorkspaceWatchCoordinator;
  watcher: FakeWatcher;
  scheduler: FakeScheduler;
  explorer: FakeExplorer;
  contexts: FakeContexts;
  documents: FakeDocuments;
}

interface HarnessOptions {
  /** The already-committed WorkContext, or `null` for a closed Workspace. */
  context?: WorkContext | null;
  /** Whether the Explorer already represents that root (default true). */
  representRoot?: boolean;
  /** Overrides the batcher's raw-payload budget. */
  stormThreshold?: number;
  /** Holds every reconciliation open until the test releases it. */
  holdReconciles?: boolean;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const context =
    options.context === undefined ? WORKSPACE_A : options.context;
  const watcher = new FakeWatcher();
  const scheduler = new FakeScheduler();
  const explorer = new FakeExplorer();
  const contexts = new FakeContexts(context);
  const documents = new FakeDocuments();

  if (context !== null && options.representRoot !== false) {
    explorer.represent(context.rootPath, []);
  }
  explorer.holdReconciles = options.holdReconciles === true;

  const deps: WorkspaceWatchCoordinatorDeps = {
    workContexts: contexts,
    explorer,
    documents,
    watcher,
    // Adjacent hints still coalesce into one batch even with a zero window,
    // because the batcher always emits through its scheduled callback.
    coalesceWindowMs: 0,
    periodicIntervalMs: PERIODIC_INTERVAL_MS,
    scheduler,
  };
  if (options.stormThreshold !== undefined) {
    deps.stormThreshold = options.stormThreshold;
  }

  return {
    coordinator: new WorkspaceWatchCoordinator(deps),
    watcher,
    scheduler,
    explorer,
    contexts,
    documents,
  };
}

/* -------------------------------------------------------------------------- */
/* Payload and assertion helpers                                              */
/* -------------------------------------------------------------------------- */

/** One `change` payload exactly as the backend would hand it to a listener. */
function rawChange(
  subscriptionId: number,
  watchedPath: string,
  relativePath: string | null,
  options: {
    hint?: WatchChangeHint;
    renameTargetRelativePath?: string | null;
    /** Raw destination, for an outside target whose relative form is `null`. */
    renameTarget?: string | null;
  } = {},
): WatchEventPayload {
  const renameTargetRelativePath = options.renameTargetRelativePath ?? null;
  return {
    type: "change",
    subscriptionId,
    scope: "recursive",
    watchedPath,
    path:
      relativePath === null ? watchedPath : joinPath(watchedPath, relativePath),
    hint: options.hint ?? "changed",
    // Only the relative spelling can ever become a Tree path, so the raw target
    // is derived from it rather than invented — unless the caller models a
    // destination outside the watch, which has no relative form at all.
    renameTarget:
      options.renameTarget !== undefined
        ? options.renameTarget
        : renameTargetRelativePath === null
          ? null
          : joinPath(watchedPath, renameTargetRelativePath),
    relativePath,
    renameTargetRelativePath,
  };
}

/** One `change` payload for the coordinator's live recursive subscription. */
function changeOn(
  watcher: FakeWatcher,
  relativePath: string | null,
  options: {
    hint?: WatchChangeHint;
    renameTargetRelativePath?: string | null;
    /** Raw destination, for an outside target whose relative form is `null`. */
    renameTarget?: string | null;
  } = {},
): WatchEventPayload {
  const subscriptionId = watcher.currentSubscriptionId();
  return rawChange(
    subscriptionId,
    watcher.watchedPathOf(subscriptionId),
    relativePath,
    options,
  );
}

/** One `invalidated` payload; `watchedPath: null` means "every interest". */
function invalidation(
  watchedPath: string | null,
  options: { scope?: WatchScope; reason?: string } = {},
): WatchEventPayload {
  return {
    type: "invalidated",
    scope: options.scope ?? "recursive",
    watchedPath,
    reason: options.reason ?? "overflow",
  };
}

/** The expected shape of one drained reconciliation request. */
function reconcileCall(
  paths: readonly string[],
  source: ReconciliationSource,
  options?: { renameCandidates?: readonly RenameCandidate[] },
): ReconcileCall {
  return options === undefined
    ? {
        method: "reconcileDirectories",
        paths: [...paths],
        source,
        options: undefined,
      }
    : {
        method: "reconcileDirectories",
        paths: [...paths],
        source,
        options,
      };
}

/** Lets the coordinator's asynchronous chain advance without a real timer. */
async function settleMicrotasks(times = 16): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

/**
 * Elapses the coalescing window and lets every scheduled reconciliation settle.
 *
 * The window is the batcher's only timer, so firing it is exactly "the window
 * elapsed"; `whenIdle` then waits for the drain that follows.
 *
 * Never call this while a reconciliation is deliberately held open: `whenIdle`
 * waits for work the test has not released yet.
 */
async function settle(harness: Harness): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    if (round === 0) {
      harness.scheduler.fireWindow();
    }
    await settleMicrotasks();
    await harness.coordinator.whenIdle();
  }
}

/** Every logical directory a test run asked the Explorer to reread. */
function reconciledPaths(explorer: FakeExplorer): string[] {
  return explorer.calls.flatMap((call) => call.paths);
}

/**
 * `count` relative paths under the never-opened `node_modules` subtree.
 *
 * A recursive watch over a package tree produces an event volume unrelated to
 * the number of *represented* directories; the fixture makes that disproportion
 * explicit without needing a real filesystem.
 */
function buildUnopenedDescendants(count: number): string[] {
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    paths.push(`node_modules\\pkg${index % 500}\\lib\\file${index}.js`);
  }
  return paths;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator lifecycle (FR-006, FR-100)", () => {
  it("installs one listener, one recursive subscription and one timer, and reconciles the represented root", async () => {
    const harness = createHarness();

    await harness.coordinator.start();
    await settle(harness);

    // Exactly one listener, one context subscription and one recursive watch.
    expect(harness.watcher.listenerCount()).toBe(1);
    expect(harness.watcher.installedCount()).toBe(1);
    expect(harness.watcher.subscribeCalls).toEqual([
      { path: ROOT, scope: "recursive" },
    ]);
    expect(harness.contexts.listenerCount()).toBe(1);
    expect(harness.coordinator.isDegraded()).toBe(false);

    // One repeating fallback timer at the injected interval, not the default.
    expect(harness.scheduler.repeatDelays).toEqual([PERIODIC_INTERVAL_MS]);
    expect(harness.scheduler.activeRepeatCount()).toBe(1);
    expect(DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS).toBe(10_000);

    // The Explorer already represented the root, so the read-then-watch gap is
    // closed by exactly one root reconciliation.
    expect(harness.explorer.calls).toEqual([
      reconcileCall([ROOT], "watcher", {}),
    ]);
  });

  it("reconciles nothing at start while the Explorer represents no root", async () => {
    const harness = createHarness({ representRoot: false });

    await harness.coordinator.start();
    await settle(harness);

    expect(harness.watcher.subscribeCalls).toEqual([
      { path: ROOT, scope: "recursive" },
    ]);
    // Without a represented root there is no Tree to reconcile, and the initial
    // load remains the later authoritative read.
    expect(harness.explorer.calls).toEqual([]);
  });

  it("installs nothing more when start() is called twice while running", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesAfterFirstStart = harness.explorer.calls.length;

    await harness.coordinator.start();
    await harness.coordinator.start();
    await settle(harness);

    expect(harness.watcher.listenerCount()).toBe(1);
    expect(harness.watcher.installedCount()).toBe(1);
    expect(harness.watcher.subscribeCalls).toHaveLength(1);
    expect(harness.contexts.listenerCount()).toBe(1);
    expect(harness.scheduler.repeatDelays).toHaveLength(1);
    expect(harness.explorer.calls).toHaveLength(reconcilesAfterFirstStart);
  });

  it("releases the subscription, the listener and the timer on dispose() and ignores later payloads", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const subscriptionId = harness.watcher.currentSubscriptionId();
    const reconcilesBefore = harness.explorer.calls.length;

    await harness.coordinator.dispose();

    expect(harness.watcher.stopped).toEqual([subscriptionId]);
    expect(harness.watcher.listenerCount()).toBe(0);
    expect(harness.watcher.unlistenCalls).toBe(1);
    expect(harness.scheduler.activeRepeatCount()).toBe(0);

    // Whatever arrives afterwards — a hint, an invalidation, a late tick, even a
    // payload aimed at the retired listener — may no longer schedule work.
    harness.watcher.emit(rawChange(subscriptionId, ROOT, "a.ts"));
    harness.watcher.emitToRetiredListener(
      0,
      rawChange(subscriptionId, ROOT, "a.ts"),
    );
    harness.watcher.emit(invalidation(ROOT));
    harness.scheduler.firePeriodic();
    harness.scheduler.fireRetiredPeriodic();
    harness.scheduler.fireWindow();
    await settle(harness);

    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);

    // Disposal is idempotent: a second call may not release anything twice.
    await harness.coordinator.dispose();
    expect(harness.watcher.stopped).toEqual([subscriptionId]);
    expect(harness.watcher.unlistenCalls).toBe(1);
  });

  it("reinstalls exactly one of each after start → dispose → start", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const firstSubscription = harness.watcher.currentSubscriptionId();

    await harness.coordinator.dispose();
    await harness.coordinator.start();
    await settle(harness);

    // Two lifecycles existed, but only one of each resource is live again.
    expect(harness.watcher.installedCount()).toBe(2);
    expect(harness.watcher.listenerCount()).toBe(1);
    expect(harness.watcher.unlistenCalls).toBe(1);
    expect(harness.watcher.subscribeCalls).toEqual([
      { path: ROOT, scope: "recursive" },
      { path: ROOT, scope: "recursive" },
    ]);
    expect(harness.watcher.stopped).toEqual([firstSubscription]);
    expect(harness.contexts.listenerCount()).toBe(1);
    expect(harness.scheduler.repeatDelays).toHaveLength(2);
    expect(harness.scheduler.activeRepeatCount()).toBe(1);
    expect(harness.explorer.calls).toHaveLength(2);
    expect(harness.explorer.calls[1]).toEqual(
      reconcileCall([ROOT], "watcher", {}),
    );
  });

  it("cannot schedule work from a retired generation's listener (FR-006)", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    await harness.coordinator.dispose();
    await harness.coordinator.start();
    await settle(harness);

    const reconcilesBefore = harness.explorer.calls.length;
    const windowsBefore = harness.scheduler.windowCount();

    // The retired lifecycle's listener is still held by the backend, and the
    // payload names the *live* subscription, so only the generation token can
    // reject it.
    harness.watcher.emitToRetiredListener(0, changeOn(harness.watcher, "a.ts"));
    expect(harness.scheduler.windowCount()).toBe(windowsBefore);
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);

    // The same payload through the live listener is accepted, which proves the
    // rejected one was otherwise valid.
    harness.watcher.emit(changeOn(harness.watcher, "a.ts"));
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);
    expect(harness.explorer.calls[reconcilesBefore].paths).toEqual([ROOT]);
  });

  it("never waits for directory I/O that is already in flight when disposing (FR-101, FR-102)", async () => {
    const harness = createHarness({ holdReconciles: true });
    await harness.coordinator.start();
    await settleMicrotasks();
    expect(harness.explorer.pendingReads()).toBe(1);

    let disposed = false;
    const disposal = harness.coordinator.dispose().then(() => {
      disposed = true;
    });
    await settleMicrotasks();

    // The read is still open, and disposal has already returned: invalidating the
    // generation is what makes the late result harmless.
    expect(harness.explorer.pendingReads()).toBe(1);
    expect(disposed).toBe(true);

    harness.explorer.releaseAll();
    await disposal;
    await settleMicrotasks();
  });
});

/* -------------------------------------------------------------------------- */
/* 005 isolation                                                              */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator event scope (005 isolation)", () => {
  it("ignores a change payload whose subscription is not the coordinator's", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;
    const windowsBefore = harness.scheduler.windowCount();

    // 005's opened-document subscription shares the channel but not the id.
    harness.watcher.emit(rawChange(999, "C:\\work\\root", "a.ts"));

    // The payload does not even reach the batcher: no window is opened at all.
    expect(harness.scheduler.windowCount()).toBe(windowsBefore);
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
  });

  it("ignores a non-recursive invalidation", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;
    const windowsBefore = harness.scheduler.windowCount();

    // A non-recursive invalidation belongs to whatever non-recursive interest
    // the backend was serving, which is 005's business.
    harness.watcher.emit(invalidation(ROOT, { scope: "nonRecursive" }));

    expect(harness.scheduler.windowCount()).toBe(windowsBefore);
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
  });

  it("accepts a backend-global invalidation", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    // `watchedPath: null` means every live consumer lost completeness, whatever
    // scope the notice carries.
    harness.watcher.emit(
      invalidation(null, { scope: "nonRecursive", reason: "watcher stopped" }),
    );
    await settle(harness);

    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);
    expect(harness.explorer.calls[reconcilesBefore]).toEqual(
      reconcileCall([ROOT, SRC], "recovery", {}),
    );
  });

  it("accepts a recursive invalidation that names the watched root, case-insensitively", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.watcher.emit(invalidation(ROOT.toLowerCase()));
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);
    expect(harness.explorer.calls[reconcilesBefore].paths).toEqual([ROOT, SRC]);

    // A recursive invalidation for another directory is somebody else's watch.
    harness.watcher.emit(invalidation("C:\\somewhere\\else"));
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Representation rules                                                       */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator representation rules (FR-023, FR-118, SC-001)", () => {
  it("creates no work for an event below a never-loaded directory (FR-023)", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.watcher.emit(changeOn(harness.watcher, "node_modules\\pkg\\lib\\a.js"));
    await settle(harness);

    // The parent is not represented, so there is nothing to reread and nothing
    // is loaded because an event happened below it.
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
    expect(reconciledPaths(harness.explorer)).not.toContain(
      joinPath(NODE_MODULES, "pkg\\lib"),
    );
  });

  it("reconciles exactly the represented but collapsed parent (SC-001, FR-075)", async () => {
    const harness = createHarness();
    // Loaded, closed, and therefore never part of a bounded sweep.
    harness.explorer.represent(ROOT, [], [SRC, COLLAPSED]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.watcher.emit(changeOn(harness.watcher, "src\\a.ts"));
    await settle(harness);

    // One hint, one reconciliation of exactly the direct parent — not the root,
    // not the expanded area, and not the file itself.
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC], "watcher", {}),
    ]);
  });

  it("rebases the hint under the logical root even when the backend watched a canonical spelling (FR-118)", async () => {
    const harness = createHarness();
    harness.watcher.canonicalize = () => CANONICAL_ROOT;
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    // The subscription really watches the canonical spelling...
    expect(
      harness.watcher.watchedPathOf(harness.watcher.currentSubscriptionId()),
    ).toBe(CANONICAL_ROOT);

    // ...while the hint's relative path is rebased under the logical root.
    harness.watcher.emit(changeOn(harness.watcher, "src\\a.ts"));
    await settle(harness);
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC], "watcher", {}),
    ]);
    expect(SRC.startsWith(ROOT)).toBe(true);
    expect(SRC.startsWith(CANONICAL_ROOT)).toBe(false);

    // A subscription-identity invalidation compares the two watcher spellings
    // case-insensitively, never as Tree paths.
    harness.watcher.emit(invalidation(CANONICAL_ROOT.toUpperCase()));
    await settle(harness);
    expect(harness.explorer.calls.slice(reconcilesBefore + 1)).toEqual([
      reconcileCall([ROOT], "recovery", {}),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Renames                                                                    */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator rename hints (FR-049)", () => {
  it("reconciles both parents in one batch and forwards the pair as a rename candidate", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC, LIB]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.watcher.emit(
      changeOn(harness.watcher, "src\\old.ts", {
        hint: "removed",
        renameTargetRelativePath: "lib\\new.ts",
      }),
    );
    await settle(harness);

    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC, LIB], "watcher", {
        renameCandidates: [
          {
            sourcePath: joinPath(SRC, "old.ts"),
            targetPath: joinPath(LIB, "new.ts"),
          },
        ],
      }),
    ]);
  });

  it("adds no destination parent when the rename target is outside the watch", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC, LIB]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.watcher.emit(
      changeOn(harness.watcher, "src\\old.ts", {
        hint: "removed",
        renameTargetRelativePath: null,
      }),
    );
    await settle(harness);

    const call = harness.explorer.calls[reconcilesBefore];
    expect(call.paths).toEqual([SRC]);
    // An outside target is a document-relocation candidate only, so no Explorer
    // path and no rename candidate may be invented for it.
    expect(call.options).toEqual({});
  });

  it("forwards the pair but adds no destination parent when that parent is not represented", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.watcher.emit(
      changeOn(harness.watcher, "src\\old.ts", {
        hint: "removed",
        renameTargetRelativePath: "unloaded\\new.ts",
      }),
    );
    await settle(harness);

    // The never-loaded destination parent is not read, while the pair stays
    // available to narrow one identity match.
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC], "watcher", {
        renameCandidates: [
          {
            sourcePath: joinPath(SRC, "old.ts"),
            targetPath: joinPath(ROOT, "unloaded\\new.ts"),
          },
        ],
      }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Storm and scale                                                            */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator storm and scale (FR-069, FR-072, FR-106)", () => {
  it("collapses ten thousand hints for one represented parent into a single reconciliation", async () => {
    const harness = createHarness({ stormThreshold: 20_000 });
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;
    const windowsBefore = harness.scheduler.windowCount();

    for (let index = 0; index < 10_000; index += 1) {
      harness.watcher.emit(changeOn(harness.watcher, `src\\file${index}.ts`));
    }

    // The whole burst is one non-restarting window...
    expect(harness.scheduler.windowCount()).toBe(windowsBefore + 1);
    await settle(harness);

    // ...and the queue is keyed by logical directory, so one parent means one
    // read rather than ten thousand of them.
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC], "watcher", {}),
    ]);
    expect(
      harness.explorer.calls.filter((call) => call.method === "reconcileDirectory"),
    ).toEqual([]);
  });

  it("reconciles at most sixteen directories per drain batch (FR-106)", async () => {
    const harness = createHarness();
    const directories = Array.from({ length: 20 }, (_unused, index) =>
      joinPath(ROOT, `dir${index}`),
    );
    harness.explorer.represent(ROOT, [], directories);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    for (let index = 0; index < directories.length; index += 1) {
      harness.watcher.emit(changeOn(harness.watcher, `dir${index}\\a.ts`));
    }
    await settle(harness);

    // One drain, two bounded batches: twenty directories may never become
    // twenty concurrent reads.
    const batches = harness.explorer.calls.slice(reconcilesBefore);
    expect(batches).toHaveLength(2);
    expect(batches[0].paths).toEqual(directories.slice(0, 16));
    expect(batches[1].paths).toEqual(directories.slice(16));
  });

  it("keeps a 100,000-descendant fixture bounded and never reconciles an unopened path (FR-023, FR-072)", async () => {
    const harness = createHarness({ stormThreshold: 20_000 });
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    const descendants = buildUnopenedDescendants(100_000);
    expect(descendants).toHaveLength(100_000);

    // Ten thousand hints: 9,900 of them below the never-opened `node_modules`
    // subtree, 100 under the one represented directory.
    for (let index = 0; index < 9_900; index += 1) {
      harness.watcher.emit(changeOn(harness.watcher, descendants[index * 10]));
    }
    for (let index = 0; index < 100; index += 1) {
      harness.watcher.emit(changeOn(harness.watcher, `src\\file${index}.ts`));
    }
    await settle(harness);

    // Bounded work: no read per event, and nothing outside the represented area.
    const reconciles = harness.explorer.calls.slice(reconcilesBefore);
    expect(reconciles).toEqual([reconcileCall([SRC], "watcher", {})]);
    expect(harness.explorer.calls.length).toBeLessThan(50);
    for (const path of reconciledPaths(harness.explorer)) {
      expect(path === ROOT || path === SRC).toBe(true);
      expect(path.startsWith(NODE_MODULES)).toBe(false);
    }
  });

  it("stays bounded across periodic passes over the same 100,000-descendant fixture (SC-002)", async () => {
    const harness = createHarness({ stormThreshold: 20_000 });
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settle(harness);

    const descendants = buildUnopenedDescendants(100_000);
    expect(descendants).toHaveLength(100_000);
    const reconcilesBefore = harness.explorer.calls.length;

    // SC-002 names startup, ordinary event handling *and* periodic
    // reconciliation, so the fallback is exercised over the same fixture.
    for (let pass = 0; pass < 3; pass += 1) {
      harness.scheduler.firePeriodic();
      await settle(harness);
    }

    const reconciles = harness.explorer.calls.slice(reconcilesBefore);
    expect(reconciles).toHaveLength(3);
    for (const reconcile of reconciles) {
      expect(reconcile.source).toBe("periodic");
      // Root + the expanded directory only: never the unopened subtree, and
      // never the loaded-but-collapsed one.
      expect(reconcile.paths).toEqual([ROOT, SRC]);
    }
    for (const path of reconciledPaths(harness.explorer)) {
      expect(path.startsWith(NODE_MODULES)).toBe(false);
      expect(path).not.toBe(COLLAPSED);
    }
  });

  it("reconciles only the root and the expanded area once a burst trips the storm threshold", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    expect(DEFAULT_WORKSPACE_STORM_THRESHOLD).toBe(512);
    for (
      let index = 0;
      index <= DEFAULT_WORKSPACE_STORM_THRESHOLD;
      index += 1
    ) {
      harness.watcher.emit(changeOn(harness.watcher, `src\\file${index}.ts`));
    }
    await settle(harness);

    // Past the budget the fine-grained detail is discarded, so recovery covers
    // the represented area instead of replaying events — and a loaded-but-
    // collapsed directory stays untouched.
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([ROOT, SRC], "recovery", {}),
    ]);
  });
});

describe("WorkspaceWatchCoordinator scheduling priority (SC-003, T084)", () => {
  it("lets a user-requested read finish ahead of the remaining recovery backlog", async () => {
    const harness = createHarness({ holdReconciles: true });
    // Twenty expanded directories: one recovery sweep is wider than a single
    // drain batch, so a bounded backlog is left waiting behind the batch in
    // flight.
    const expanded = Array.from({ length: 20 }, (_unused, index) =>
      joinPath(ROOT, `pkg-${index}`),
    );
    harness.explorer.represent(ROOT, expanded);
    await harness.coordinator.start();
    await settleMicrotasks();
    harness.explorer.releaseAll();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.explorer.holdReconciles = true;
    harness.coordinator.notifyFocusRegained();
    await settleMicrotasks();

    // One bounded batch of sixteen directories is in flight; the remaining five
    // wait in the queue behind it.
    expect(harness.explorer.calls.length - reconcilesBefore).toBe(1);
    expect(harness.explorer.calls[reconcilesBefore].paths).toHaveLength(16);
    expect(harness.explorer.pendingReads()).toBe(1);

    // The user expands a directory: ExplorerController starts that read
    // immediately rather than queueing it behind the coordinator's backlog
    // (FR-071, SC-003).
    harness.explorer.holdReconciles = false;
    await harness.explorer.reconcileDirectory(expanded[0], "user");

    const lastCall = harness.explorer.calls[harness.explorer.calls.length - 1];
    expect(lastCall.source).toBe("user");
    expect(lastCall.paths).toEqual([expanded[0]]);
    // The recovery batch is still open, i.e. the user read did not wait for it.
    expect(harness.explorer.pendingReads()).toBe(1);
  });

  it("keeps the strongest pending intent for one directory", async () => {
    const harness = createHarness({ holdReconciles: true });
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settleMicrotasks();
    harness.explorer.releaseAll();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    // A recovery intent, then a direct watcher hint for the same directory: the
    // stronger source replaces the weaker one instead of being appended, so ten
    // thousand hints still produce one queued directory (FR-068, FR-106).
    harness.coordinator.notifyFocusRegained();
    harness.watcher.emit(changeOn(harness.watcher, "src\\a.ts"));
    harness.explorer.releaseAll();
    await settle(harness);

    const drained = harness.explorer.calls.slice(reconcilesBefore);
    const forSrc = drained.filter((call) => call.paths.includes(SRC));
    expect(forSrc).toHaveLength(1);
    expect(forSrc[0].source).toBe("watcher");
  });
});

/* -------------------------------------------------------------------------- */
/* Periodic fallback                                                          */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator periodic fallback (FR-073, FR-074, SC-009)", () => {
  it("reconciles the root and the expanded directories and skips loaded-but-collapsed ones", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.scheduler.firePeriodic();
    await settle(harness);

    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([ROOT, SRC], "periodic"),
    ]);
  });

  it("skips a tick while a pass is still running (FR-077)", async () => {
    const harness = createHarness({ holdReconciles: true });
    await harness.coordinator.start();
    await settleMicrotasks();
    // The start-time root reconciliation is still open.
    expect(harness.explorer.calls).toHaveLength(1);

    harness.scheduler.firePeriodic();
    await settleMicrotasks();
    expect(harness.explorer.calls).toHaveLength(2);
    expect(harness.explorer.calls[1].source).toBe("periodic");

    // A tick while the pass is open is coalesced away rather than stacked.
    harness.scheduler.firePeriodic();
    await settleMicrotasks();
    expect(harness.explorer.calls).toHaveLength(2);

    harness.explorer.releaseAll();
    await settle(harness);

    // Idle again, so the next tick runs a fresh pass.
    harness.scheduler.firePeriodic();
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(3);
    expect(harness.explorer.calls[2].source).toBe("periodic");
  });

  it("never reads a loaded-but-collapsed directory across a full 60-second idle window (SC-009)", async () => {
    // The named product cadence, not the test harness's convenient 60s override:
    // six ticks are exactly 60 seconds of idle time and the whole window must
    // stay collapsed-free.
    expect(DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS).toBe(10_000);

    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED, NODE_MODULES]);

    const coordinator = new WorkspaceWatchCoordinator({
      workContexts: harness.contexts,
      explorer: harness.explorer,
      documents: harness.documents,
      watcher: harness.watcher,
      scheduler: harness.scheduler,
      periodicIntervalMs: DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS,
    });

    await coordinator.start();
    await settle(harness);
    expect(harness.scheduler.repeatDelays).toEqual([
      DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS,
    ]);
    const reconcilesBefore = harness.explorer.calls.length;

    const TICKS_FOR_ONE_MINUTE =
      (60_000 / DEFAULT_WORKSPACE_PERIODIC_INTERVAL_MS) as number;
    expect(TICKS_FOR_ONE_MINUTE).toBe(6);
    for (let index = 0; index < TICKS_FOR_ONE_MINUTE; index += 1) {
      harness.scheduler.firePeriodic();
      await settle(harness);
    }

    const passes = harness.explorer.calls.slice(reconcilesBefore);
    // Every eligible expanded directory stays covered on every pass...
    expect(passes).toHaveLength(TICKS_FOR_ONE_MINUTE);
    expect(passes.every((call) => call.source === "periodic")).toBe(true);
    for (const call of passes) {
      expect(call.paths).toEqual([ROOT, SRC]);
    }

    // ...while nothing inside a loaded-but-collapsed subtree is read once.
    const readPaths = reconciledPaths(harness.explorer);
    expect(readPaths).not.toContain(COLLAPSED);
    expect(readPaths).not.toContain(NODE_MODULES);
    expect(readPaths.some((path) => path.startsWith(NODE_MODULES))).toBe(false);

    await coordinator.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Focus regain                                                               */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator focus regain (FR-079, FR-094)", () => {
  it("reconciles the root and the expanded area", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.coordinator.notifyFocusRegained();
    await settle(harness);

    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([ROOT, SRC], "recovery", {}),
    ]);
    expect(reconciledPaths(harness.explorer)).not.toContain(COLLAPSED);
  });

  it("does not start a second concurrent pass while one is in flight (FR-094)", async () => {
    const harness = createHarness({ holdReconciles: true });
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settleMicrotasks();
    const reconcilesBefore = harness.explorer.calls.length;
    expect(reconcilesBefore).toBe(1);

    // Two focus regains while the batch is open join the pending queue; neither
    // starts a second concurrent read.
    harness.coordinator.notifyFocusRegained();
    await settleMicrotasks();
    harness.coordinator.notifyFocusRegained();
    await settleMicrotasks();
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);

    harness.explorer.releaseAll();
    await settle(harness);

    // The accumulated queue is reconciled once the in-flight batch has settled,
    // so the area is never read in parallel with itself.
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);
    expect(harness.explorer.calls[reconcilesBefore].paths).toEqual([ROOT, SRC]);
  });

  it("merges a focus regain into a periodic pass already in flight (FR-094)", async () => {
    const harness = createHarness({ holdReconciles: true });
    harness.explorer.represent(ROOT, [SRC], [COLLAPSED]);
    await harness.coordinator.start();
    await settleMicrotasks();
    harness.explorer.releaseAll();
    await settle(harness);

    // A periodic pass is running, reconciling exactly root + expanded area.
    harness.explorer.holdReconciles = true;
    harness.scheduler.firePeriodic();
    await settleMicrotasks();
    const reconcilesBefore = harness.explorer.calls.length;
    expect(harness.explorer.calls[reconcilesBefore - 1].source).toBe("periodic");

    // Focus regain must be absorbed by that pass rather than starting a second
    // concurrent sweep of the same directories.
    harness.coordinator.notifyFocusRegained();
    await settleMicrotasks();
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);

    harness.explorer.releaseAll();
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* Degraded mode                                                              */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator degraded mode (FR-007, FR-008, FR-099)", () => {
  it("keeps the Workspace usable and the fallback armed when the root cannot be watched", async () => {
    const harness = createHarness();
    harness.watcher.failSubscribeCount = 1;

    await harness.coordinator.start();
    await settle(harness);

    // Degraded is internal: the recursive watch failed, nothing else did.
    expect(harness.coordinator.isDegraded()).toBe(true);
    expect(harness.watcher.subscribeCalls).toEqual([
      { path: ROOT, scope: "recursive" },
    ]);
    expect(harness.watcher.stopped).toEqual([]);
    // The periodic fallback stays armed...
    expect(harness.scheduler.activeRepeatCount()).toBe(1);
    // ...and no root reconciliation was attempted, because there is no watch to
    // close a gap for.
    expect(harness.explorer.calls).toEqual([]);

    // The Workspace still converges through the bounded, non-realtime paths, and
    // the first such opportunity also repairs the watch (FR-099).
    harness.coordinator.notifyFocusRegained();
    await settle(harness);
    harness.scheduler.firePeriodic();
    await settle(harness);

    expect(harness.coordinator.isDegraded()).toBe(false);
    expect(harness.watcher.subscribeCalls).toHaveLength(2);
    expect(harness.explorer.calls).toHaveLength(2);
    expect(harness.explorer.calls[0]).toEqual(
      reconcileCall([ROOT], "recovery", {}),
    );
    expect(harness.explorer.calls[1]).toEqual(reconcileCall([ROOT], "periodic"));

    // Only the read/ask Explorer surface was ever reached: the port has no
    // root-unavailable channel, so a failed watch cannot be signalled as one.
    expect(
      harness.explorer.methods().every((method) => EXPLORER_READ_SURFACE.has(method)),
    ).toBe(true);
  });

  it("retries a degraded subscription on a later opportunity without stacking attempts", async () => {
    const harness = createHarness();
    // The start-time attempt and the first retry both fail.
    harness.watcher.failSubscribeCount = 2;

    await harness.coordinator.start();
    await settle(harness);
    expect(harness.coordinator.isDegraded()).toBe(true);
    expect(harness.watcher.subscribeCalls).toHaveLength(1);

    // A focus regain is a retry opportunity, and it also converges the
    // represented area even while the retry fails.
    harness.coordinator.notifyFocusRegained();
    await settle(harness);
    expect(harness.watcher.subscribeCalls).toHaveLength(2);
    expect(harness.coordinator.isDegraded()).toBe(true);
    expect(harness.explorer.calls).toHaveLength(1);

    // A periodic tick is the next opportunity, and this one recovers.
    harness.scheduler.firePeriodic();
    await settle(harness);
    expect(harness.watcher.subscribeCalls).toHaveLength(3);
    expect(harness.coordinator.isDegraded()).toBe(false);

    // Once the watch is live, further opportunities do not touch it again.
    harness.coordinator.notifyFocusRegained();
    await settle(harness);
    expect(harness.watcher.subscribeCalls).toHaveLength(3);
    expect(harness.scheduler.activeRepeatCount()).toBe(1);

    // A new watch generation is a new opportunity, and it stays live.
    await harness.coordinator.dispose();
    await harness.coordinator.start();
    await settle(harness);
    expect(harness.watcher.subscribeCalls).toHaveLength(4);
    expect(harness.coordinator.isDegraded()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* WorkContext replacement                                                    */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator WorkContext replacement (FR-006)", () => {
  it("stops the previous subscription, ignores its late payloads and follows the new root", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const subscriptionA = harness.watcher.currentSubscriptionId();
    const reconcilesBefore = harness.explorer.calls.length;

    // The Explorer has already rebuilt for B by the time the commit arrives.
    harness.explorer.represent(B_ROOT, [B_SRC]);
    harness.contexts.commit(WORKSPACE_B);
    await settle(harness);

    expect(harness.watcher.stopped).toEqual([subscriptionA]);
    expect(harness.watcher.subscribeCalls).toEqual([
      { path: ROOT, scope: "recursive" },
      { path: B_ROOT, scope: "recursive" },
    ]);
    expect(harness.watcher.listenerCount()).toBe(1);
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([B_ROOT], "watcher", {}),
    ]);

    // Late payloads of the retired Workspace are inert: not even a window opens.
    const windowsBefore = harness.scheduler.windowCount();
    harness.watcher.emit(rawChange(subscriptionA, ROOT, "a.ts"));
    harness.watcher.emit(invalidation(ROOT));
    expect(harness.scheduler.windowCount()).toBe(windowsBefore);
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);

    // The new subscription is the live one, and its paths rebase under B.
    harness.watcher.emit(changeOn(harness.watcher, "src\\b.ts"));
    await settle(harness);
    expect(harness.explorer.calls.slice(reconcilesBefore + 1)).toEqual([
      reconcileCall([B_SRC], "watcher", {}),
    ]);
  });

  it("stops the timer and the subscription when the Workspace closes", async () => {
    const harness = createHarness();
    await harness.coordinator.start();
    await settle(harness);
    const subscriptionId = harness.watcher.currentSubscriptionId();
    const reconcilesBefore = harness.explorer.calls.length;

    harness.contexts.commit(null);
    await settle(harness);

    expect(harness.watcher.stopped).toEqual([subscriptionId]);
    expect(harness.scheduler.activeRepeatCount()).toBe(0);
    expect(harness.coordinator.isDegraded()).toBe(false);
    // The listener outlives the Workspace: the coordinator is still mounting, it
    // simply has nothing to watch.
    expect(harness.watcher.listenerCount()).toBe(1);

    harness.watcher.emit(rawChange(subscriptionId, ROOT, "a.ts"));
    harness.watcher.emit(invalidation(ROOT));
    harness.scheduler.firePeriodic();
    harness.scheduler.fireRetiredPeriodic();
    harness.scheduler.fireWindow();
    await settle(harness);

    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* Relocation adoption                                                        */
/* -------------------------------------------------------------------------- */

describe("WorkspaceWatchCoordinator relocation adoption (FR-064)", () => {
  it("adopts a confirmed relocation with the exact request for both kinds", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    const movedFile: ConfirmedExplorerRelocation = {
      kind: "file",
      oldPath: joinPath(SRC, "a.ts"),
      newPath: joinPath(LIB, "a.ts"),
      objectIdentity: "object:file",
    };
    const movedDirectory: ConfirmedExplorerRelocation = {
      kind: "directory",
      oldPath: joinPath(SRC, "pkg"),
      newPath: joinPath(LIB, "pkg"),
      objectIdentity: "object:directory",
    };
    harness.explorer.queueResult({
      applied: true,
      relocations: [movedFile, movedDirectory],
      directories: [],
    });

    harness.watcher.emit(changeOn(harness.watcher, "src\\a.ts"));
    await settle(harness);

    // Only the Explorer's proof travels to 005, and the entry identity is carried
    // verbatim as `entryObjectIdentity`.
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC], "watcher", {}),
    ]);
    expect(harness.documents.requests).toEqual([
      {
        oldPath: movedFile.oldPath,
        newPath: movedFile.newPath,
        kind: "file",
        entryObjectIdentity: "object:file",
      },
      {
        oldPath: movedDirectory.oldPath,
        newPath: movedDirectory.newPath,
        kind: "directory",
        entryObjectIdentity: "object:directory",
      },
    ]);
  });

  it("does not roll a rejected relocation back", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], []);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    const movedFile: ConfirmedExplorerRelocation = {
      kind: "file",
      oldPath: joinPath(SRC, "a.ts"),
      newPath: joinPath(LIB, "a.ts"),
      objectIdentity: "object:file",
    };
    harness.explorer.queueResult({
      applied: true,
      relocations: [movedFile],
      directories: [],
    });
    harness.documents.outcomes = [
      {
        documentId: "doc-1",
        status: "rejected",
        path: movedFile.oldPath,
        reason: "identity-mismatch",
      },
    ];

    harness.scheduler.firePeriodic();
    await settle(harness);

    expect(harness.documents.requests).toHaveLength(1);
    // A rejection is not a structural failure: it buys exactly one pass and no
    // compensating Explorer write.
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);

    // The next pass still runs normally.
    harness.scheduler.firePeriodic();
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 2);
    expect(harness.documents.requests).toHaveLength(1);
  });

  it("keeps reconciling when the adoption itself fails", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC], []);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.explorer.queueResult({
      applied: true,
      relocations: [
        {
          kind: "directory",
          oldPath: joinPath(SRC, "pkg"),
          newPath: joinPath(LIB, "pkg"),
          objectIdentity: "object:directory",
        },
      ],
      directories: [],
    });
    harness.documents.failNext = true;

    harness.scheduler.firePeriodic();
    await settle(harness);

    // The failure is contained: 005 stays authoritative for the document and the
    // next pass is unaffected.
    expect(harness.documents.requests).toHaveLength(1);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 1);

    harness.scheduler.firePeriodic();
    await settle(harness);
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore + 2);
  });
});

describe("WorkspaceWatchCoordinator root non-follow (FR-054, FR-097, FR-098)", () => {
  it("never adopts a root-self event or a watcher rename target as the Workspace root", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;
    const contextBefore = harness.contexts.getContext();

    // A rename of the root itself: the backend may report the source with a
    // destination, and the root-self event has no subscription-relative path.
    harness.watcher.emit(
      changeOn(harness.watcher, null, {
        hint: "removed",
        renameTargetRelativePath: null,
      }),
    );
    await settle(harness);

    // 006 keeps the WorkContext bound to the root the user chose: a moved root is
    // not followed, and the rename target is never treated as a Tree path.
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
    expect(harness.contexts.getContext()).toEqual(contextBefore);
    // The root still converges through direct reads, which is what notices a
    // root that disappeared even when no root-entry event arrives (FR-012).
    harness.scheduler.firePeriodic();
    await settle(harness);
    expect(harness.explorer.calls[reconcilesBefore].paths).toContain(ROOT);
    expect(harness.contexts.getContext()).toEqual(contextBefore);
  });
});

describe("WorkspaceWatchCoordinator document-only relocation (FR-050, FR-051, FR-065)", () => {
  it("offers an unrepresented destination to DocumentManager without loading it", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    // The source parent is represented; the destination parent is not (it was
    // never opened) and the hint therefore carries no in-root target relative
    // path, only the raw one.
    const OUTSIDE = joinPath(ROOT, "lib");
    harness.watcher.emit(
      changeOn(harness.watcher, "src\\a.ts", {
        hint: "removed",
        renameTargetRelativePath: null,
        renameTarget: joinPath(OUTSIDE, "a.ts"),
      }),
    );
    await settle(harness);

    // The Tree branch was never loaded: only the represented source parent was
    // reconciled...
    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC], "watcher", {}),
    ]);
    // ...while the document side received the candidate, with no entry token
    // relabelled as a document target identity.
    expect(harness.documents.requests).toEqual([
      {
        oldPath: joinPath(SRC, "a.ts"),
        newPath: joinPath(OUTSIDE, "a.ts"),
        kind: "file",
        entryObjectIdentity: null,
      },
    ]);
  });

  it("never proposes adoption for a plain create with no source/target candidate", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);

    // A move *into* the Workspace is structurally a creation; without a paired
    // source/target candidate 006 must not go looking for open documents that
    // happen to be the same object (FR-051).
    harness.watcher.emit(changeOn(harness.watcher, "imported.ts", { hint: "created" }));
    await settle(harness);

    expect(harness.documents.requests).toEqual([]);
  });

  it("leaves an out-of-root move to 005 when the destination cannot be proven", async () => {
    const harness = createHarness();
    harness.documents.outcomes = [
      {
        documentId: "doc-1",
        status: "rejected",
        path: "C:\\work\\src\\a.ts",
        reason: "identity-mismatch",
      },
    ];
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);

    harness.watcher.emit(
      changeOn(harness.watcher, "src\\a.ts", {
        hint: "removed",
        renameTargetRelativePath: null,
        renameTarget: "D:\\elsewhere\\a.ts",
      }),
    );
    await settle(harness);

    // A refusal changes nothing structural: the Explorer still follows the disk,
    // and the document stays where 005 can validate it.
    expect(harness.documents.requests).toHaveLength(1);
    const calls = harness.explorer.calls;
    expect(calls[calls.length - 1]?.paths).toEqual([SRC]);
  });
});

describe("WorkspaceWatchCoordinator never-opened directories (FR-023, FR-029)", () => {
  it("creates no work for hints under a represented but never-read directory", async () => {
    const harness = createHarness();
    // A collapsed `node_modules` row: the user can see it, but it was never read.
    const NODE_MODULES = joinPath(ROOT, "node_modules");
    harness.explorer.represent(ROOT, [], [NODE_MODULES], {
      neverRead: [NODE_MODULES],
    });
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    // An install storm: hundreds of direct-child hints below that row.
    for (let index = 0; index < 200; index += 1) {
      harness.watcher.emit(
        changeOn(harness.watcher, joinPath("node_modules", `pkg-${index}.js`)),
      );
    }
    await settle(harness);

    // Not one of them may load the directory: only real user expansion does.
    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
  });

  it("still reconciles a loaded-but-collapsed directory on a direct hint (FR-075)", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [], [SRC]);
    await harness.coordinator.start();
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    harness.watcher.emit(changeOn(harness.watcher, "src\\a.ts"));
    await settle(harness);

    expect(harness.explorer.calls.slice(reconcilesBefore)).toEqual([
      reconcileCall([SRC], "watcher", {}),
    ]);
  });
});

describe("WorkspaceWatchCoordinator context generations (FR-005, FR-100, SC-007)", () => {
  it("stops a handshake that resolves after its Workspace was replaced", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC]);
    // Workspace A's handshake never resolves before B replaces it.
    harness.watcher.deferSubscribe = true;

    const started = harness.coordinator.start();
    await settleMicrotasks();
    expect(harness.watcher.subscribeCalls).toEqual([
      { path: ROOT, scope: "recursive" },
    ]);
    const aSubscription = harness.watcher.liveSubscriptionIdsNow()[0];

    // B replaces A. B's own handshake is issued immediately instead of being
    // refused by A's still-in-flight attempt.
    harness.explorer.represent(B_ROOT, [B_SRC]);
    harness.watcher.deferSubscribe = false;
    harness.contexts.commit(WORKSPACE_B);
    await settleMicrotasks();
    expect(harness.watcher.subscribeCalls).toEqual([
      { path: ROOT, scope: "recursive" },
      { path: B_ROOT, scope: "recursive" },
    ]);

    // A's handle resolves late; it is stopped rather than installed.
    harness.watcher.releaseSubscribes();
    await started;
    await settle(harness);

    expect(harness.watcher.stopped).toContain(aSubscription);
    expect(harness.watcher.liveSubscriptionIdsNow()).toHaveLength(1);
    expect(harness.coordinator.isDegraded()).toBe(false);
  });

  it("drops a batch window that was opened under the previous Workspace", async () => {
    const harness = createHarness();
    harness.explorer.represent(ROOT, [SRC]);
    await harness.coordinator.start();
    await settle(harness);

    // A hint opens a coalescing window under Workspace A.
    harness.watcher.emit(changeOn(harness.watcher, "src\\a.ts"));
    await settleMicrotasks();

    // The Workspace is replaced before that window fires.
    harness.explorer.represent(B_ROOT, [B_SRC]);
    harness.contexts.commit(WORKSPACE_B);
    await settle(harness);
    const reconcilesBefore = harness.explorer.calls.length;

    // Firing the retired window must produce nothing for B: the hints it
    // collected belong to the context the user left.
    harness.scheduler.fireWindow();
    await settle(harness);

    expect(harness.explorer.calls).toHaveLength(reconcilesBefore);
    expect(harness.documents.requests).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Real controller, real coordinator: periodic sweep breadth (T142)            */
/* -------------------------------------------------------------------------- */

/** A one-level reader that records every directory it is asked for. */
class CountingDirectoryReader implements ExplorerFileReader {
  readonly reads: string[] = [];
  private readonly listings = new Map<string, WorkspaceDirectoryEntry[]>();

  add(path: string, entries: WorkspaceDirectoryEntry[]): void {
    this.listings.set(path.toLowerCase(), entries);
  }

  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult> {
    this.reads.push(path);
    const entries = this.listings.get(path.toLowerCase());
    if (entries === undefined) {
      return Promise.reject({
        code: "io_directory",
        message: `No fixture registered for ${path}`,
      });
    }
    return Promise.resolve({
      requestedPath: path,
      canonicalPath: path,
      comparisonKey: path.replace(/\\/g, "/").toLowerCase(),
      caseSensitive: false,
      entries,
    });
  }
}

function directoryEntry(
  path: string,
  kind: WorkspaceEntryKind,
): WorkspaceDirectoryEntry {
  const separator = path.lastIndexOf("\\");
  return {
    name: separator < 0 ? path : path.slice(separator + 1),
    path,
    kind,
    isSymlink: false,
    objectIdentity: `obj:${path.toLowerCase()}`,
  };
}

describe("WorkspaceWatchCoordinator periodic sweep with a real controller (T142)", () => {
  it("reads exactly the expanded area the controller reports, never a collapsed directory", async () => {
    const MANY = Array.from({ length: 120 }, (_unused, index) =>
      joinPath(ROOT, `pkg-${String(index).padStart(3, "0")}`),
    );
    const reader = new CountingDirectoryReader();
    reader.add(
      ROOT,
      MANY.map((path) => directoryEntry(path, "directory")),
    );
    for (const path of MANY) {
      reader.add(path, [directoryEntry(joinPath(path, "index.ts"), "file")]);
    }

    // The real Tree owner, not a stand-in: this is what makes the breadth claim
    // about `listExpandedDirectoryPaths()` meaningful.
    const controller = new ExplorerController({ workspaceFileService: reader });
    controller.setContext(WORKSPACE_A);
    await controller.whenIdle();

    for (const path of MANY) {
      await controller.expandDirectory(path);
      await controller.toggleDirectory(path);
    }
    const EXPANDED = MANY.slice(0, 3);
    for (const path of EXPANDED) {
      await controller.expandDirectory(path);
    }
    await controller.whenIdle();

    const realList = controller.listExpandedDirectoryPaths();

    expect(realList).toEqual([ROOT, ...EXPANDED]);

    const harness = createHarness();
    const coordinator = new WorkspaceWatchCoordinator({
      workContexts: harness.contexts,
      explorer: controller,
      documents: harness.documents,
      watcher: harness.watcher,
      scheduler: harness.scheduler,
      coalesceWindowMs: 0,
      periodicIntervalMs: PERIODIC_INTERVAL_MS,
    });

    await coordinator.start();
    await coordinator.whenIdle();

    reader.reads.length = 0;
    harness.scheduler.firePeriodic();
    await coordinator.whenIdle();

    expect([...reader.reads].sort()).toEqual([...realList].sort());
    for (const collapsed of MANY.slice(3)) {
      expect(reader.reads).not.toContain(collapsed);
    }

    await coordinator.dispose();
  });
});

describe("WorkspaceWatchCoordinator drain handoff (FR-100, FR-101)", () => {
  it("reconciles the replacement root when a stale drain exits across dispose/start", async () => {
    const harness = createHarness({ holdReconciles: true });
    harness.explorer.represent(ROOT, [SRC]);
    const coordinator = harness.coordinator;

    await coordinator.start();
    await settleMicrotasks();
    // The initial root reconciliation is held open, so the first drain is
    // genuinely still running.
    expect(harness.explorer.pendingReads()).toBe(1);

    // Close and immediately reopen a different Workspace while that drain is
    // stuck. Its queued work is dropped with the old generation.
    await coordinator.dispose();
    harness.explorer.represent(B_ROOT, [B_SRC]);
    harness.contexts.commit(WORKSPACE_B);
    await coordinator.start();
    await settleMicrotasks();

    const callsBeforeHandoff = harness.explorer.calls.length;
    // Releasing the stale read lets the old drain exit; it must hand the pending
    // work of the *current* generation over instead of leaving it queued behind a
    // drain that is already gone (FR-101).
    harness.explorer.releaseAll();
    await settle(harness);

    expect(harness.explorer.calls.slice(callsBeforeHandoff).map((call) => call.paths)).toEqual([
      [B_ROOT],
    ]);

    await coordinator.dispose();
  });
});
