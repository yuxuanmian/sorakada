/**
 * Lazy Explorer tree controller.
 *
 * The controller owns everything transient about browsing a Workspace: the
 * single-root tree, expansion, per-directory load/cache/error state, selection,
 * the one inline editor, and reconciliation. It performs no filesystem work
 * itself — every read goes through the injected service — which keeps the
 * lazy-loading, stale-result and identity rules testable without a desktop
 * shell.
 *
 * Three rules shape the whole implementation:
 *
 * 1. Only directories the user actually expands (or that a relevant hint
 *    targets) are read, so cost follows represented state rather than total
 *    project size (FR-023, FR-072). A never-loaded directory is never read
 *    because an event happened below it.
 * 2. Every directory read goes through *one* primitive — {@link
 *    ExplorerController.reconcileDirectories} — which every caller (lazy load,
 *    first expansion, cached re-expansion, watcher/periodic reconciliation and
 *    Manual Refresh) shares, so no two pipelines can commit contradictory
 *    versions of one directory (FR-017, FR-105).
 * 3. Every asynchronous completion proves that its WorkContext generation, its
 *    node and its request generation are still current before mutating anything;
 *    I/O is never assumed cancellable, only non-committable (FR-020, FR-112).
 */

import { toFileCommandError } from "../../services/fileService";
import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import type { WorkContext } from "../workspace/workContext";
import { isWithinDirectory } from "../workspace/workContext";
import {
  DIRECTORY_CYCLE_MESSAGE,
  ancestorCanonicalPaths,
  collectDirectoryPaths,
  createDirectoryNode,
  createEmptyExplorerState,
  findDirectoryNode,
  findNode,
  findParentDirectory,
  rebaseNodePaths,
  sortExplorerEntries,
  toExplorerNode,
  type ExplorerDirectoryNode,
  type ExplorerNode,
  type ExplorerState,
  type InlineEditState,
} from "./explorerModel";
import {
  reconcileDirectorySnapshots,
  rebasePathUnder,
  type ConfirmedExplorerRelocation,
  type DirectorySnapshot,
  type RenameCandidate,
} from "./explorerReconciliation";

/** The part of the Workspace service the Explorer reads through. */
export interface ExplorerFileReader {
  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult>;
}

export interface ExplorerControllerDeps {
  workspaceFileService: ExplorerFileReader;
  /**
   * Called when the root read fails or recovers, so the application can expose
   * the unavailable state without closing the WorkContext (FR-095).
   */
  onRootUnavailable?(unavailable: boolean): void;
}

export type ExplorerStateListener = (state: ExplorerState) => void;

/** What kind of entry an inline create editor is about to make. */
export type CreateEntryKind = "file" | "directory";

/**
 * Why a reconciliation was requested (006).
 *
 * The rank decides which *pending* intent a directory keeps when several
 * callers ask at once; it never changes what a completed read is allowed to
 * apply. User work outranks background recovery, which is what keeps an
 * expansion responsive while a storm backlog drains (FR-071).
 */
export type ReconciliationSource =
  | "user"
  | "manual-refresh"
  | "watcher"
  | "re-expansion"
  | "recovery"
  | "periodic";

const SOURCE_RANK: Record<ReconciliationSource, number> = {
  user: 6,
  "manual-refresh": 5,
  watcher: 4,
  "re-expansion": 3,
  recovery: 2,
  periodic: 1,
};

/** The stronger of two sources, so a node keeps the most urgent pending intent. */
function strongestSource(
  left: ReconciliationSource,
  right: ReconciliationSource,
): ReconciliationSource {
  return SOURCE_RANK[right] > SOURCE_RANK[left] ? right : left;
}

/** What one reconciliation request produced. */
export interface DirectoryReconciliationResult {
  /** The logical directory the request was about. */
  path: string;
  /** Whether a fresh listing was committed to the Tree. */
  applied: boolean;
  /** Relocations proven while reconciling. */
  relocations: readonly ConfirmedExplorerRelocation[];
  /** Paths that disappeared with no proven continuity. */
  removedPaths: readonly string[];
  /** Paths that appeared with no proven continuity. */
  addedPaths: readonly string[];
}

/** The result of reconciling several directories as one batch (006 US2). */
export interface BatchReconciliationResult {
  applied: boolean;
  relocations: readonly ConfirmedExplorerRelocation[];
  directories: readonly DirectoryReconciliationResult[];
}

const EMPTY_DIRECTORY_RESULT: Omit<DirectoryReconciliationResult, "path"> = {
  applied: false,
  relocations: [],
  removedPaths: [],
  addedPaths: [],
};

/**
 * Per-directory reconciliation bookkeeping (FR-018, FR-019, FR-105).
 *
 * It exists to deduplicate and serialize direct-child reads: at most one
 * authoritative read per node runs at a time, a request that arrives meanwhile
 * only marks the directory dirty again, and only the newest read of a node owns
 * the right to apply its result.
 */
interface DirectoryReadState {
  /** Monotonic token of the newest read that owns apply rights for this node. */
  token: number;
  /** Whether an authoritative read of this node is in flight. */
  inFlight: boolean;
  /** A relevant request arrived while the read was in flight (FR-019). */
  dirtyAgain: boolean;
  /** The strongest pending source, for priority bookkeeping. */
  source: ReconciliationSource;
  /** Resolves when the round currently in flight has settled. */
  completion: Promise<unknown>;
}

/** One node taking part in a batch, with the snapshot captured before the read. */
interface BatchTarget {
  node: ExplorerDirectoryNode;
  token: number;
  state: DirectoryReadState;
  snapshot: DirectorySnapshot;
}

/** The outcome of reading one directory level. */
type ListingResult =
  | { status: "ok"; result: ReadWorkspaceDirectoryResult }
  | { status: "error"; error: unknown }
  | { status: "dropped" };

export class ExplorerController {
  private readonly deps: ExplorerControllerDeps;
  private readonly listeners = new Set<ExplorerStateListener>();

  private state: ExplorerState = createEmptyExplorerState();
  private context: WorkContext | null = null;

  /**
   * Per-node reconciliation state.
   *
   * The context generation only changes when the Workspace is replaced, so two
   * reads of the *same* node (a Refresh overlapping a watcher read, or two
   * refreshes) need a second guard: only the newest read of a node may apply its
   * result (FR-020, FR-021).
   */
  private readonly readStates = new WeakMap<ExplorerDirectoryNode, DirectoryReadState>();
  private readSequence = 0;

  /** Every reconciliation round still running, so `whenIdle` can observe it. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: ExplorerControllerDeps) {
    this.deps = deps;
  }

  /* ---------------------------------------------------------------------- */
  /* Read surface                                                           */
  /* ---------------------------------------------------------------------- */

  /** The current transient Explorer state. */
  getState(): ExplorerState {
    return this.state;
  }

  /** The Workspace this state belongs to, or `null`. */
  getContext(): WorkContext | null {
    return this.context;
  }

  /** The currently selected entry's path, or `null`. */
  getSelectedPath(): string | null {
    return this.state.selectedPath;
  }

  /** The selected node, or `null` when nothing concrete is selected. */
  getSelectedNode(): ExplorerNode | null {
    return findNode(this.state.root, this.state.selectedPath ?? "");
  }

  /** Any visible node by path. */
  getNode(path: string): ExplorerNode | null {
    return findNode(this.state.root, path);
  }

  /** The active inline editor, if any. */
  getInlineEdit(): InlineEditState | null {
    return this.state.inlineEdit;
  }

  /** Subscribes to Explorer state changes; returns the unsubscribe function. */
  subscribe(listener: ExplorerStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Directory query surface (006 US1)                                       */
  /* ---------------------------------------------------------------------- */

  /** The path of the represented root, or `null` while no Workspace is open. */
  getRepresentedRootPath(): string | null {
    return this.state.root?.path ?? null;
  }

  /**
   * Whether `path` is a directory the Tree currently represents.
   *
   * The Workspace watcher may *query* this before scheduling work; it must never
   * mutate node records itself (Constitution II).
   */
  isDirectoryRepresented(path: string): boolean {
    return findDirectoryNode(this.state.root, path) !== null;
  }

  /**
   * Whether `path` is represented *and* has already been read once.
   *
   * This is the predicate background synchronization asks, not
   * {@link isDirectoryRepresented}: a visible row the user never opened (a
   * collapsed `node_modules`, for instance) is represented without having been
   * read, and a watcher event under it must NOT load it — that is exactly the
   * recursive crawler 006 forbids (FR-023, FR-029, FR-072). A failed read still
   * counts as read, because the directory genuinely was opened and its error row
   * converges through the same bounded path Manual Refresh uses.
   */
  isDirectoryRead(path: string): boolean {
    const node = findDirectoryNode(this.state.root, path);
    if (node === null) {
      return false;
    }
    return node.loadState === "loaded" || node.loadState === "error";
  }

  /** Whether `path` is represented and its read succeeded (test/UI seam). */
  isDirectoryLoaded(path: string): boolean {
    const node = findDirectoryNode(this.state.root, path);
    return node !== null && node.loadState === "loaded";
  }

  /**
   * Every represented directory that is currently expanded, outermost first.
   *
   * This is the bounded target set for periodic and overflow recovery: it never
   * discovers unloaded descendants, and a loaded-but-collapsed directory is
   * deliberately excluded so cached history cannot turn into a crawler
   * (FR-070, FR-074).
   *
   * Traversal stops at a collapsed node, so a descendant that was expanded before
   * its ancestor was collapsed is *not* in the sweep even though its own
   * `expanded` flag is still stored for the moment the ancestor opens again
   * (US4-AC3). Pruning the list is what makes the guarantee hold; the stored flag
   * is deliberately left untouched so expansion state survives.
   */
  listExpandedDirectoryPaths(): string[] {
    const root = this.state.root;
    if (root === null) {
      return [];
    }

    const paths: string[] = [];
    const walk = (node: ExplorerDirectoryNode): void => {
      if (!node.expanded) {
        return;
      }
      paths.push(node.path);
      for (const child of node.children ?? []) {
        if (child.kind === "directory") {
          walk(child);
        }
      }
    };
    walk(root);
    return paths;
  }

  /* ---------------------------------------------------------------------- */
  /* Context                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Points the Explorer at a Workspace, or at none.
   *
   * A new Workspace replaces the previous context's transient tree state instead
   * of restoring it, and cancels any uncommitted inline edit (FR-087). Passing
   * the *same* Workspace again is a no-op, which is what makes reopening an
   * equivalent root path leave the user's expansion and selection alone.
   */
  setContext(context: WorkContext | null): void {
    const nextContextId = context?.id ?? null;
    if (nextContextId === this.state.contextId) {
      this.context = context;
      return;
    }

    this.context = context;
    this.state = {
      ...createEmptyExplorerState(),
      generation: this.state.generation + 1,
      contextId: nextContextId,
    };

    if (context !== null) {
      this.state.root = createDirectoryNode(
        { name: context.displayName, path: context.rootPath },
        { expanded: true, resolvedCanonicalPath: context.canonicalRootPath },
      );
    }

    this.emit();

    if (context !== null) {
      void this.loadRoot();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Clears a previous root-unavailable report after the root was proven
   * readable.
   *
   * Opening a Workspace — including reopening the same canonical root — reads
   * its root, so the Explorer's unavailable state and error row must not outlive
   * that recovery (FR-095, FR-097). A root node that had failed is read again so
   * its children come back without the user having to Refresh.
   */
  markRootAvailable(): void {
    if (this.state.rootUnavailable) {
      this.state.rootUnavailable = false;
      this.emit();
    }

    const root = this.state.root;
    if (root !== null && root.loadState === "error") {
      void this.loadRoot();
    }
  }

  /** Reads the Workspace root's direct children. */
  async loadRoot(): Promise<void> {
    const root = this.state.root;
    if (root === null) {
      return;
    }

    await this.reconcileDirectories([root.path], "user");
  }

  /**
   * Expands or collapses a directory.
   *
   * Collapsing while a read is in flight does not cancel it: the completion may
   * cache the children, but it must not force the directory open again
   * (FR-114).
   */
  async toggleDirectory(path: string): Promise<void> {
    const node = findDirectoryNode(this.state.root, path);
    if (node === null) {
      return;
    }

    if (node.expanded) {
      node.expanded = false;
      this.emit();
      return;
    }

    await this.expandDirectory(path);
  }

  /**
   * Expands a directory, reading it the first time and reconciling it after.
   *
   * 006 supersedes the 003 "cached re-expansion never rereads" rule (SR-002):
   * cached children still render immediately, but a loaded directory also
   * requests one bounded direct-child reconciliation so externally stale cache
   * converges without waiting for the next periodic pass (FR-076).
   *
   * A node whose read failed is deliberately *not* retried here: retrying a
   * failing directory on every toggle is what Manual Refresh is for.
   */
  async expandDirectory(path: string): Promise<void> {
    const node = findDirectoryNode(this.state.root, path);
    if (node === null) {
      return;
    }

    node.expanded = true;
    this.emit();

    if (node.loadState === "loaded") {
      // The cache is already on screen; the reconciliation request is
      // deliberately not awaited, so expanding stays responsive (FR-076).
      void this.reconcileDirectory(path, "re-expansion");
      return;
    }

    if (node.loadState === "error" || node.loadState === "loading") {
      return;
    }

    await this.reconcileDirectory(path, "user");
  }

  /**
   * Reconciles one represented directory with the filesystem (FR-017).
   *
   * Only a directory the Tree already represents is ever read, so a hint for a
   * never-loaded directory creates zero background reads (FR-023). The returned
   * promise settles when the directory's work — including the bounded
   * dirty-again follow-up — has finished, which is the coordinator's completion
   * seam.
   */
  reconcileDirectory(
    path: string,
    source: ReconciliationSource = "watcher",
    options: { renameCandidates?: readonly RenameCandidate[] } = {},
  ): Promise<DirectoryReconciliationResult> {
    const node = findDirectoryNode(this.state.root, path);
    if (node === null) {
      return Promise.resolve({ path, ...EMPTY_DIRECTORY_RESULT });
    }

    return this.reconcileNodes([node], source, false, options).then(
      (batch) =>
        batch.directories[0] ?? { path, ...EMPTY_DIRECTORY_RESULT },
    );
  }

  /**
   * Reconciles several represented directories as one bounded batch (006 US2).
   *
   * A batch is what makes a cross-parent move provable: the source parent's
   * removal and the target parent's addition are matched inside one snapshot set
   * taken before anything is applied, so no remembered history participates.
   * Relocation matching and every apply decision use the pre-apply state, and a
   * batch whose generation went stale applies nothing.
   */
  reconcileDirectories(
    paths: readonly string[],
    source: ReconciliationSource = "watcher",
    options: { renameCandidates?: readonly RenameCandidate[] } = {},
  ): Promise<BatchReconciliationResult> {
    const nodes: ExplorerDirectoryNode[] = [];
    for (const path of paths) {
      const node = findDirectoryNode(this.state.root, path);
      if (node !== null && !nodes.includes(node)) {
        nodes.push(node);
      }
    }

    if (nodes.length === 0) {
      return Promise.resolve({ applied: false, relocations: [], directories: [] });
    }

    return this.reconcileNodes(nodes, source, false, options);
  }

  /**
   * Reconciles the tree with the filesystem (FR-080..FR-082).
   *
   * Every directory that has already been read is reread — including
   * loaded-but-collapsed ones — while directories that were never opened stay
   * untouched, so Refresh never turns into a recursive scan. Refresh cancels an
   * uncommitted inline edit first and supersedes older background results, so a
   * slower watcher read can never overwrite the user's newer view.
   */
  async refresh(): Promise<void> {
    const root = this.state.root;
    if (root === null) {
      return;
    }

    // Refresh cancels an uncommitted inline edit before applying filesystem
    // state, so a draft can never be committed against a newer tree (FR-082).
    this.cancelInlineEdit();

    const generation = this.state.generation;
    const targets = collectDirectoryPaths(root).filter((path) => {
      const node = findDirectoryNode(this.state.root, path);
      return (
        node !== null &&
        (node.loadState === "loaded" || node.loadState === "error")
      );
    });

    if (targets.length === 0) {
      // Nothing has been read yet, so "refresh" means "read the root".
      await this.loadRoot();
      this.reconcileSelection();
      this.emit();
      return;
    }

    for (const path of targets) {
      if (generation !== this.state.generation) {
        // The Workspace was replaced or closed mid-refresh: the rest of this
        // refresh belongs to a tree the user already left.
        return;
      }

      const node = findDirectoryNode(this.state.root, path);
      if (node === null) {
        // A parent's refresh showed that this directory no longer exists.
        continue;
      }

      // `force` is what makes Refresh supersede a background read of the same
      // directory instead of joining it (FR-021).
      await this.reconcileNodes([node], "manual-refresh", true);
    }

    this.reconcileSelection();
    this.emit();
  }

  /** Waits until no reconciliation round is running (test/coordinator seam). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Selection                                                              */
  /* ---------------------------------------------------------------------- */

  /** Sets the persistent operation-context selection. */
  selectPath(path: string | null): void {
    if (this.state.selectedPath === path) {
      return;
    }

    this.state.selectedPath = path;
    this.emit();
  }

  /** Clears the selection, which is what blank-space context needs (FR-077). */
  clearSelection(): void {
    this.selectPath(null);
  }

  /* ---------------------------------------------------------------------- */
  /* Inline editing                                                         */
  /* ---------------------------------------------------------------------- */

  /** Starts the inline New File/New Folder editor under `parentPath`. */
  beginCreate(kind: CreateEntryKind, parentPath: string): void {
    this.state.inlineEdit = {
      type: kind === "file" ? "create-file" : "create-folder",
      parentPath,
      draftName: "",
    };
    this.emit();
  }

  /** Starts the inline Rename editor for `sourcePath`. */
  beginRename(sourcePath: string): void {
    const node = findNode(this.state.root, sourcePath);
    if (node === null) {
      return;
    }

    this.state.inlineEdit = {
      type: "rename",
      sourcePath,
      originalName: node.name,
      draftName: node.name,
    };
    this.emit();
  }

  /** Records an inline editor keystroke. */
  updateInlineDraft(draftName: string): void {
    const edit = this.state.inlineEdit;
    if (edit === null) {
      return;
    }

    edit.draftName = draftName;
    this.emit();
  }

  /** Discards the inline editor without touching the filesystem. */
  cancelInlineEdit(): void {
    if (this.state.inlineEdit === null) {
      return;
    }

    this.state.inlineEdit = null;
    this.emit();
  }

  /* ---------------------------------------------------------------------- */
  /* Mutation reconciliation                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Inserts a successfully created entry into its parent's cached children.
   *
   * A Sorakada-originated mutation updates the tree directly, so no manual
   * Refresh is needed (FR-026), and a failed creation simply never reaches here
   * (FR-057).
   */
  applyCreatedEntry(
    parentPath: string,
    entry: WorkspaceDirectoryEntry,
  ): void {
    const parent = findDirectoryNode(this.state.root, parentPath);
    if (parent === null || parent.children === undefined) {
      return;
    }
    if (parent.children.some((child) => child.path === entry.path)) {
      return;
    }

    parent.children = sortExplorerEntries([
      ...parent.children,
      toExplorerNode(entry),
    ]);
    parent.expanded = true;
    this.emit();
  }

  /**
   * Applies a successful internal rename to the visible tree.
   *
   * The renamed node keeps its identity and cached subtree; only names and paths
   * change, so an expanded directory stays expanded under its new name.
   */
  applyRenamedEntry(request: {
    sourcePath: string;
    newPath: string;
    newName: string;
  }): void {
    const node = findNode(this.state.root, request.sourcePath);
    if (node === null) {
      return;
    }

    const parent = findParentDirectory(this.state.root, request.sourcePath);

    rebaseNodePaths(node, request.sourcePath, request.newPath);
    node.name = request.newName;

    if (parent !== null && parent.children !== undefined) {
      parent.children = sortExplorerEntries(parent.children);
    }

    const selected = this.state.selectedPath;
    if (selected !== null) {
      const rebased = rebasePathUnder(request.sourcePath, request.newPath, selected);
      if (rebased !== null) {
        this.state.selectedPath = rebased;
      }
    }

    this.moveInlineEdit(request.sourcePath, request.newPath);

    this.emit();
  }

  /**
   * Applies a successful internal delete to the visible tree.
   *
   * The node and any selection inside it disappear together, because document
   * sessions for those paths are removed at the same time (FR-072).
   */
  applyDeletedEntry(path: string): void {
    const parent = findParentDirectory(this.state.root, path);
    if (parent === null || parent.children === undefined) {
      return;
    }

    parent.children = parent.children.filter((child) => child.path !== path);

    const selected = this.state.selectedPath;
    if (selected !== null && isWithinDirectory(path, selected)) {
      // Component-aware, so deleting `src` does not clear a selection in `src2`.
      this.state.selectedPath = null;
    }

    const edit = this.state.inlineEdit;
    if (edit !== null && isWithinDirectory(path, editTargetPath(edit))) {
      this.state.inlineEdit = null;
    }

    this.emit();
  }

  /* ---------------------------------------------------------------------- */
  /* Reconciliation internals                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The canonical reconciliation primitive (FR-017, FR-105).
   *
   * It captures each target's pre-apply snapshot, issues one authoritative
   * one-level read per directory, and applies the whole batch only when every
   * participating node is still current. A request that arrives for a directory
   * that is already being read does not start a second read: it marks the
   * directory dirty again, and at most one follow-up round runs afterwards
   * (FR-018, FR-019).
   */
  private async reconcileNodes(
    nodes: readonly ExplorerDirectoryNode[],
    source: ReconciliationSource,
    force: boolean,
    options: { renameCandidates?: readonly RenameCandidate[] } = {},
  ): Promise<BatchReconciliationResult> {
    const generation = this.state.generation;
    const targets: BatchTarget[] = [];
    const joined: Promise<unknown>[] = [];

    for (const node of nodes) {
      const existing = this.readStates.get(node);
      if (!force && existing !== undefined && existing.inFlight) {
        existing.dirtyAgain = true;
        existing.source = strongestSource(existing.source, source);
        joined.push(existing.completion);
        continue;
      }

      const token = this.readSequence + 1;
      this.readSequence = token;
      const state: DirectoryReadState = {
        token,
        inFlight: true,
        dirtyAgain: false,
        source,
        completion: Promise.resolve(),
      };
      this.readStates.set(node, state);
      targets.push({
        node,
        token,
        state,
        // The snapshot is taken *before* the read, so a relocation is matched
        // against the state the user is looking at, not against a half-applied
        // result (FR-050 in `explorerReconciliation`).
        snapshot: {
          path: node.path,
          current: [...(node.children ?? [])],
          entries: [],
        },
      });

      if (node.loadState !== "loaded") {
        // A first read shows its progress; a background reread of a loaded
        // directory stays invisible until it has something to apply (FR-093).
        node.loadState = "loading";
        node.errorMessage = undefined;
      }
    }

    if (targets.length === 0) {
      await Promise.all(joined);
      return { applied: false, relocations: [], directories: [] };
    }

    this.emit();

    const round = (async (): Promise<BatchReconciliationResult> => {
      // Every read is issued before any of them is awaited: a batch must observe
      // one filesystem state for the relocation proof to mean anything.
      const listings = await Promise.all(
        targets.map((target) => this.readOneLevel(target.node)),
      );

      // A node that left the tree (its parent was removed, it was relocated, or
      // the whole Workspace was replaced) can never be reconciled again, so the
      // batch is dropped *without* a follow-up: retrying a node nobody
      // represents would spin forever.
      const unreachable = targets.some(
        (target) => !this.isNodeReachable(target, generation),
      );
      if (unreachable) {
        return this.finishRound(targets, {
          applied: false,
          relocations: [],
          directories: [],
        });
      }

      // A newer read of the same node (an explicit Refresh, or a forced
      // reconciliation) owns the apply rights now. The batch is dropped, and
      // only the nodes a follow-up can still correct are marked dirty (FR-021).
      let superseded = false;
      targets.forEach((target, index) => {
        if (
          this.readStates.get(target.node) !== target.state ||
          target.state.token !== target.token ||
          listings[index].status === "dropped"
        ) {
          superseded = true;
        }
      });

      if (superseded) {
        for (const target of targets) {
          if (this.readStates.get(target.node) === target.state) {
            target.state.dirtyAgain = true;
          }
        }
        return this.finishRound(targets, {
          applied: false,
          relocations: [],
          directories: [],
        });
      }

      return this.applyBatch(targets, listings, generation, options);
    })();

    for (const target of targets) {
      target.state.completion = round;
    }
    this.track(round);

    const result = await round;

    for (const target of targets) {
      target.state.inFlight = false;
    }

    // At most one follow-up per node per settling round (FR-019): hints that
    // arrived during the read made the directory dirty, not a storm of reads.
    const followUps = targets
      .filter((target) => target.state.dirtyAgain)
      .map((target) => this.reconcileNodes([target.node], target.state.source, true));
    if (followUps.length > 0) {
      await Promise.all(followUps);
    }

    await Promise.all(joined);
    return result;
  }

  /** Applies one batch's listings, or decides it cannot be applied. */
  private applyBatch(
    targets: readonly BatchTarget[],
    listings: readonly ListingResult[],
    generation: number,
    options: { renameCandidates?: readonly RenameCandidate[] } = {},
  ): BatchReconciliationResult {
    const snapshots: DirectorySnapshot[] = [];
    const canonicalByNode = new Map<ExplorerDirectoryNode, string>();
    const usableTargets: BatchTarget[] = [];

    targets.forEach((target, index) => {
      const listing = listings[index];

      if (listing.status === "error") {
        target.node.loadState = "error";
        // The root's failure already has a dedicated projection: the panel-level
        // "this folder could not be read" notice plus the retry paths (Refresh,
        // periodic pass, focus regain). Rendering the raw filesystem message on
        // the root row as well would duplicate it inside the Tree, where a long
        // OS message cannot fit a one-line row and collides with its neighbours
        // (FR-095).
        //
        // A *non-root* directory keeps its localized message: that failure stays
        // local to its node, which is exactly what FR-025 requires.
        target.node.errorMessage =
          target.node === this.state.root
            ? undefined
            : toFileCommandError(listing.error, "io_directory").message;
        this.reportRootAvailability(target.node.path, true);
        return;
      }
      if (listing.status === "dropped") {
        return;
      }

      const result = listing.result;

      // 006: the root may only recover at the *same* canonical location. A root
      // path whose target was replaced by a different directory (a re-pointed
      // symlink/junction) is not a recovery, and adopting it would silently show
      // the user a different folder under the same name (FR-097, FR-098). It is
      // reported through the same panel-level unavailable projection rather than
      // as a second message inside the Tree.
      if (
        target.node === this.state.root &&
        this.context !== null &&
        result.comparisonKey !== this.context.comparisonKey
      ) {
        target.node.loadState = "error";
        target.node.errorMessage = undefined;
        this.reportRootAvailability(target.node.path, true);
        return;
      }

      const ancestors = ancestorCanonicalPaths(this.state.root, target.node.path);
      if (ancestors.includes(result.canonicalPath)) {
        // Ancestor-chain protection applies to background reconciliation exactly
        // as it does to a user expansion (FR-089): following this directory's
        // canonical target would repeat an ancestor.
        target.node.loadState = "error";
        target.node.errorMessage = DIRECTORY_CYCLE_MESSAGE;
        target.node.resolvedCanonicalPath = result.canonicalPath;
        target.node.children = [];
        this.reportRootAvailability(target.node.path, false);
        return;
      }

      snapshots.push({
        path: target.snapshot.path,
        current: target.snapshot.current,
        entries: result.entries,
      });
      canonicalByNode.set(target.node, result.canonicalPath);
      usableTargets.push(target);
    });

    const outcome = reconcileDirectorySnapshots({
      snapshots,
      ...(options.renameCandidates === undefined
        ? {}
        : { renameCandidates: options.renameCandidates }),
    });

    const directories: DirectoryReconciliationResult[] = [];
    usableTargets.forEach((target, index) => {
      const reconciled = outcome.directories[index];
      if (reconciled === undefined) {
        return;
      }

      target.node.children = reconciled.children;
      target.node.resolvedCanonicalPath = canonicalByNode.get(target.node);
      target.node.loadState = "loaded";
      target.node.errorMessage = undefined;
      this.reportRootAvailability(target.node.path, false);

      directories.push({
        path: reconciled.path,
        applied: true,
        relocations: reconciled.arrivals,
        removedPaths: reconciled.removedPaths,
        addedPaths: reconciled.addedPaths,
      });
    });

    if (generation !== this.state.generation) {
      return { applied: false, relocations: [], directories: [] };
    }

    this.applyInteractionState(outcome.relocations, directories);

    if (directories.length > 0) {
      this.emit();
    }

    return {
      applied: directories.length > 0,
      relocations: outcome.relocations,
      directories,
    };
  }

  /** Keeps selection and the inline editor coherent with an applied batch. */
  private applyInteractionState(
    relocations: readonly ConfirmedExplorerRelocation[],
    directories: readonly DirectoryReconciliationResult[],
  ): void {
    for (const relocation of relocations) {
      const selected = this.state.selectedPath;
      if (selected !== null) {
        const rebased = rebasePathUnder(
          relocation.oldPath,
          relocation.newPath,
          selected,
        );
        if (rebased !== null) {
          this.state.selectedPath = rebased;
        }
      }

      const edit = this.state.inlineEdit;
      if (edit === null) {
        continue;
      }

      this.moveInlineEdit(relocation.oldPath, relocation.newPath);
    }

    // A selection whose logical node is provably gone is cleared (FR-086); an
    // unrelated structural update leaves it exactly as it was (FR-085), and a
    // confirmed relocation already rebased it above.
    const selected = this.state.selectedPath;
    if (selected !== null && findNode(this.state.root, selected) === null) {
      this.state.selectedPath = null;
    }

    // The inline editor is only cancelled when *its own* target or its parent
    // context disappeared — never merely because background state changed
    // (FR-087, FR-088).
    const edit = this.state.inlineEdit;
    if (edit !== null) {
      const targetPath = editTargetPath(edit);
      const removed = directories.flatMap((directory) => directory.removedPaths);
      const targetGone =
        removed.some((path) => isWithinDirectory(path, targetPath)) ||
        findNode(this.state.root, targetPath) === null;
      if (targetGone) {
        this.state.inlineEdit = null;
      }
    }
  }

  /**
   * Keeps the inline editor coherent when an entry moved from `oldPath` to
   * `newPath`.
   *
   * A rename draft is *cancelled* rather than rebased: its source path and
   * `originalName` describe the old location, so silently following the move
   * would let a commit rename a path the user never chose (FR-087, US6-AC5). A
   * create draft follows its parent directory instead, because only the directory
   * the new entry will be created in moved (FR-088).
   */
  private moveInlineEdit(oldPath: string, newPath: string): void {
    const edit = this.state.inlineEdit;
    if (edit === null) {
      return;
    }

    if (edit.type === "rename") {
      if (isWithinDirectory(oldPath, edit.sourcePath)) {
        this.state.inlineEdit = null;
      }
      return;
    }

    const rebasedParent = rebasePathUnder(oldPath, newPath, edit.parentPath);
    if (rebasedParent !== null) {
      this.state.inlineEdit = { ...edit, parentPath: rebasedParent };
    }
  }

  /** Finishes a round that could not apply anything. */  private finishRound(
    targets: readonly BatchTarget[],
    result: BatchReconciliationResult,
  ): BatchReconciliationResult {
    for (const target of targets) {
      target.state.inFlight = false;
    }
    return result;
  }

  /**
   * Whether the node a read was issued for is still part of the current tree.
   *
   * A parent removal, a relocation or a Workspace replacement takes the node out
   * of reach; the completion must then be dropped rather than applied, and no
   * retry may be scheduled for a node nobody represents any more (FR-024).
   */
  private isNodeReachable(target: BatchTarget, generation: number): boolean {
    if (generation !== this.state.generation) {
      return false;
    }
    return findNode(this.state.root, target.snapshot.path) === target.node;
  }

  /** Reads exactly one directory level, without applying anything. */
  private async readOneLevel(node: ExplorerDirectoryNode): Promise<ListingResult> {
    const requestedPath = node.path;
    try {
      const result = await this.deps.workspaceFileService.readWorkspaceDirectory(
        requestedPath,
      );
      return { status: "ok", result };
    } catch (error) {
      return { status: "error", error };
    }
  }

  /** Keeps the application's root-unavailable state in step with reads. */
  private reportRootAvailability(path: string, unavailable: boolean): void {
    const root = this.state.root;
    if (root === null || path !== root.path) {
      return;
    }

    if (this.state.rootUnavailable === unavailable) {
      return;
    }

    this.state.rootUnavailable = unavailable;
    this.deps.onRootUnavailable?.(unavailable);
  }

  /** Clears a selection whose path no longer exists after Refresh (FR-085). */
  private reconcileSelection(): void {
    const selected = this.state.selectedPath;
    if (selected === null) {
      return;
    }

    if (findNode(this.state.root, selected) === null) {
      this.state.selectedPath = null;
    }
  }

  /** Tracks a round so `whenIdle` can observe it. */
  private track(run: Promise<unknown>): void {
    let tracked: Promise<void>;
    tracked = run
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
  }
  /**
   * Publishes a new state object.
   *
   * Node records are updated in place, so a fresh wrapper object is what tells
   * React that something changed.
   */
  private emit(): void {
    const snapshot: ExplorerState = { ...this.state };
    this.state = snapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

/** The logical path an inline editor's validity depends on. */
function editTargetPath(edit: InlineEditState): string {
  return edit.type === "rename" ? edit.sourcePath : edit.parentPath;
}

/** Re-exported so callers can type a rename candidate without a deep import. */
export type { RenameCandidate };
