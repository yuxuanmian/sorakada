/**
 * Lazy Explorer tree controller.
 *
 * The controller owns everything transient about browsing a Workspace: the
 * single-root tree, expansion, per-directory load/cache/error state, selection,
 * the one inline editor, and Refresh reconciliation. It performs no filesystem
 * work itself — every read goes through the injected service — which keeps the
 * lazy-loading and stale-result rules testable without a desktop shell.
 *
 * Two rules shape the whole implementation:
 *
 * 1. Only directories the user actually expands are read, so browsing cost
 *    follows loaded directories rather than total project size (FR-026).
 * 2. Every asynchronous completion checks the generation it started under, so a
 *    result from a previous WorkContext can never mutate the current tree
 *    (FR-030).
 */

import { toFileCommandError } from "../../services/fileService";
import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import type { WorkContext } from "../workspace/workContext";
import {
  isWithinDirectory,
  joinPath,
  relativeWithinDirectory,
} from "../workspace/workContext";
import {
  DIRECTORY_CYCLE_MESSAGE,
  ancestorCanonicalPaths,
  collectDirectoryPaths,
  createDirectoryNode,
  createEmptyExplorerState,
  findDirectoryNode,
  findNode,
  findParentDirectory,
  mergeChildren,
  rebaseNodePaths,
  sortExplorerEntries,
  toExplorerNode,
  type ExplorerDirectoryNode,
  type ExplorerNode,
  type ExplorerState,
  type InlineEditState,
} from "./explorerModel";

/** The part of the Workspace service the Explorer reads through. */
export interface ExplorerFileReader {
  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult>;
}

export interface ExplorerControllerDeps {
  workspaceFileService: ExplorerFileReader;
  /**
   * Called when the root read fails or recovers, so the application can expose
   * the unavailable state without closing the WorkContext (FR-088).
   */
  onRootUnavailable?(unavailable: boolean): void;
}

export type ExplorerStateListener = (state: ExplorerState) => void;

/** What kind of entry an inline create editor is about to make. */
export type CreateEntryKind = "file" | "directory";

export class ExplorerController {
  private readonly deps: ExplorerControllerDeps;
  private readonly listeners = new Set<ExplorerStateListener>();

  private state: ExplorerState = createEmptyExplorerState();
  private context: WorkContext | null = null;

  /**
   * Per-node read tokens.
   *
   * The context generation only changes when the Workspace is replaced, so two
   * reads of the *same* node (a Refresh overlapping a load, or two refreshes)
   * need a second guard: only the newest read of a node may apply its result,
   * otherwise a slower, older listing could overwrite a newer one (FR-030).
   */
  private readonly readTokens = new WeakMap<ExplorerDirectoryNode, number>();
  private readSequence = 0;

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
  /* Context                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Points the Explorer at a Workspace, or at none.
   *
   * A new Workspace replaces the previous context's transient tree state instead
   * of restoring it, and cancels any uncommitted inline edit (FR-089). Passing
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
   * that recovery (FR-086, FR-088). A root node that had failed is read again so
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

    await this.readDirectoryInto(root);
  }

  /**
   * Expands or collapses a directory.
   *
   * Collapsing while a read is in flight does not cancel it: the completion may
   * cache the children, but it must not force the directory open again
   * (FR-028 acceptance 4).
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

  /** Expands a directory, reading its children the first time (FR-026). */
  async expandDirectory(path: string): Promise<void> {
    const node = findDirectoryNode(this.state.root, path);
    if (node === null) {
      return;
    }

    node.expanded = true;
    this.emit();

    // Cached children are reused; a node whose load failed or was stopped for a
    // cycle retries only through Refresh.
    if (node.loadState !== "not-loaded") {
      return;
    }

    await this.readDirectoryInto(node);
  }

  /**
   * Reconciles the tree with the filesystem (FR-082..FR-085).
   *
   * Every directory that has already been read is reread — including
   * loaded-but-collapsed ones — while directories that were never opened stay
   * untouched, so Refresh never turns into a recursive scan. Expansion survives
   * for paths that still exist and a stale selection is cleared.
   */
  async refresh(): Promise<void> {
    const root = this.state.root;
    if (root === null) {
      return;
    }

    // Refresh cancels an uncommitted inline edit before applying filesystem
    // state, so a draft can never be committed against a newer tree (FR-089).
    this.cancelInlineEdit();

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
      const reference = this.state.generation;
      const node = findDirectoryNode(this.state.root, path);
      if (node === null) {
        // A parent's refresh showed that this directory no longer exists.
        continue;
      }

      await this.readDirectoryInto(node);

      if (reference !== this.state.generation) {
        // The Workspace was replaced or closed mid-refresh: the rest of this
        // refresh belongs to a tree the user already left.
        return;
      }
    }

    this.reconcileSelection();
    this.emit();
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
   * Refresh is needed (FR-086), and a failed creation simply never reaches here
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
   * Applies a successful rename to the visible tree.
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

    if (
      parent !== null &&
      parent.children !== undefined
    ) {
      parent.children = sortExplorerEntries(parent.children);
    }

    const selected = this.state.selectedPath;
    if (selected !== null && isWithinDirectory(request.sourcePath, selected)) {
      // Containment is decided per path component, so renaming `src` never
      // rebases a selection in a prefix sibling such as `src2` (FR-043).
      const suffix = relativeWithinDirectory(request.sourcePath, selected);
      this.state.selectedPath =
        suffix === null ? selected : joinPath(request.newPath, suffix);
    }

    this.emit();
  }

  /**
   * Applies a successful delete to the visible tree.
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

    this.emit();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Reads one directory level into `node`.
   *
   * Two tokens decide whether the result may be applied: the context generation
   * captured before the await, which a WorkContext replacement increments, and
   * this node's read token, which a newer read of the same directory replaces.
   * Either mismatch drops the completion entirely.
   */
  private async readDirectoryInto(node: ExplorerDirectoryNode): Promise<void> {
    const generation = this.state.generation;
    const requestedPath = node.path;
    const token = this.readSequence + 1;
    this.readSequence = token;
    this.readTokens.set(node, token);

    node.loadState = "loading";
    node.errorMessage = undefined;
    this.emit();

    let result: ReadWorkspaceDirectoryResult;
    try {
      result = await this.deps.workspaceFileService.readWorkspaceDirectory(
        requestedPath,
      );
    } catch (error) {
      if (!this.mayApplyRead(node, generation, token)) {
        return;
      }

      node.loadState = "error";
      node.errorMessage = toFileCommandError(error, "io_directory").message;
      this.reportRootAvailability(requestedPath, true);
      this.emit();
      return;
    }

    if (!this.mayApplyRead(node, generation, token)) {
      return;
    }

    this.applyReadResult(node, result);
    this.emit();
  }

  /** Whether a completed read is still the current one for its node. */
  private mayApplyRead(
    node: ExplorerDirectoryNode,
    generation: number,
    token: number,
  ): boolean {
    if (generation !== this.state.generation) {
      return false;
    }
    return this.readTokens.get(node) === token;
  }

  /** Applies one successful directory read, including the ancestor-cycle rule. */
  private applyReadResult(
    node: ExplorerDirectoryNode,
    result: ReadWorkspaceDirectoryResult,
  ): void {
    // Ancestor-chain protection: following this directory's canonical target
    // would repeat a directory already in the current chain, so it becomes a
    // non-recursing node. Links that do not cycle stay fully browsable, because
    // no global visited graph is kept (FR-034).
    const ancestors = ancestorCanonicalPaths(this.state.root, node.path);
    if (ancestors.includes(result.canonicalPath)) {
      node.loadState = "error";
      node.errorMessage = DIRECTORY_CYCLE_MESSAGE;
      node.resolvedCanonicalPath = result.canonicalPath;
      node.children = [];
      this.reportRootAvailability(node.path, false);
      return;
    }

    node.resolvedCanonicalPath = result.canonicalPath;
    node.children = mergeChildren(node.children, result.entries);
    node.loadState = "loaded";
    node.errorMessage = undefined;
    this.reportRootAvailability(node.path, false);
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
