import { describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";

import type { FileCommandError, ResolvedPathIdentity } from "../../services/fileService";
import type {
  CreateWorkspaceEntryRequest,
  CreateWorkspaceEntryResult,
  ReadWorkspaceDirectoryResult,
  RenameWorkspaceEntryRequest,
  RenameWorkspaceEntryResult,
  ResolveWorkspaceRelationResult,
  WorkspaceDirectoryEntry,
  WorkspaceEntryKind,
  WorkspaceFileService,
} from "../../services/workspaceFileService";
import type {
  DeleteConfirmationRequest,
  WorkspaceDialogService,
} from "../../services/workspaceDialogs";
import {
  NEW_DOCUMENT_FORMAT,
  type DocumentSession,
} from "../document/documentSession";
import type {
  CommittedPathRename,
  OpenPathResult,
  PathMutationRequest,
  PathMutationResult,
} from "../document/documentManager";
import type { WorkContext } from "../workspace/workContext";
import { displayNameForWorkspaceRoot } from "../workspace/workContext";
import {
  ExplorerActions,
  SOURCE_ENTRY_CHANGED_MESSAGE,
  deriveFileOperationContext,
  isContextMenuCreateAvailable,
  isCreateAvailable,
  isDeleteAvailable,
  isRefreshAvailable,
  isRenameAvailable,
  parentPathOf,
  type ExplorerActionTarget,
  type ExplorerDocumentPort,
} from "./explorerActions";
import {
  rebaseNodePaths,
  toExplorerNode,
  type ExplorerDirectoryNode,
  type ExplorerNode,
  type ExplorerState,
  type InlineEditState,
} from "./explorerModel";
import { reconcileDirectorySnapshots } from "./explorerReconciliation";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

function keyFor(path: string): string {
  return path.toLowerCase();
}

function leafName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

const ROOT = "C:\\work";
const SRC = "C:\\work\\src";
const FILE_A = "C:\\work\\src\\a.ts";

function context(rootPath = ROOT): WorkContext {
  return {
    id: `workspace-${rootPath}`,
    rootPath,
    canonicalRootPath: rootPath,
    comparisonKey: keyFor(rootPath),
    displayName: displayNameForWorkspaceRoot(rootPath),
  };
}

function directoryNode(path: string): ExplorerDirectoryNode {
  return {
    name: leafName(path),
    path,
    kind: "directory",
    isSymlink: false,
    objectIdentity: `fake:${keyFor(path)}`,
    expanded: true,
    loadState: "loaded",
    children: [],
  };
}

function fileNode(path: string): ExplorerNode {
  return {
    name: leafName(path),
    path,
    kind: "file",
    isSymlink: false,
    objectIdentity: `fake:${keyFor(path)}`,
  };
}

/**
 * One direct child as the one-level workspace read reports it.
 *
 * The identity matches the Tree node helpers above, so a fixture that seeds a
 * listing describes the same on-disk object its Tree already shows.
 */
function listEntry(
  path: string,
  kind: WorkspaceEntryKind = "file",
): WorkspaceDirectoryEntry {
  return {
    name: leafName(path),
    path,
    kind,
    isSymlink: false,
    objectIdentity: `fake:${keyFor(path)}`,
  };
}

/** The same entry, as if another process had replaced the object at that path. */
function replacedEntry(
  path: string,
  identity: string | null,
  kind: WorkspaceEntryKind = "file",
): WorkspaceDirectoryEntry {
  return { ...listEntry(path, kind), objectIdentity: identity };
}

/**
 * The same on-disk object, now at `toPath`.
 *
 * A same-volume rename preserves the entry's own token, so this is what a
 * watcher echo reports after an internal Rename.
 */
function movedEntry(
  fromPath: string,
  toPath: string,
  kind: WorkspaceEntryKind = "file",
): WorkspaceDirectoryEntry {
  return {
    ...listEntry(toPath, kind),
    objectIdentity: `fake:${keyFor(fromPath)}`,
  };
}

/** Sorted paths of a parent's visible direct children. */
function childPaths(explorer: FakeExplorer, parentPath: string): string[] {
  return explorer
    .childrenOf(parentPath)
    .map((node) => node.path)
    .sort();
}

/** A recording stand-in for the Explorer controller. */
class FakeExplorer implements ExplorerActionTarget {
  readonly calls: string[] = [];

  selectedPath: string | null = null;
  nodes = new Map<string, ExplorerNode>();
  inlineEdit: InlineEditState | null = null;
  generation = 1;
  /** The Workspace context this Tree belongs to; a test may replace it. */
  contextId: string | null = "workspace";
  rootUnavailable = false;

  /**
   * Visible direct children per parent path.
   *
   * The fake keeps a small structural model beside `nodes` so the T119
   * idempotence test can assert the *Tree* after an internal mutation plus a
   * watcher echo, using the real identity-aware reconciliation the controller
   * uses. It is deliberately minimal: this is a recording stand-in, not a second
   * controller implementation.
   */
  private readonly childLists = new Map<string, ExplorerNode[]>();

  /** The visible direct children of `parentPath`. */
  childrenOf(parentPath: string): readonly ExplorerNode[] {
    return this.childLists.get(keyFor(parentPath)) ?? [];
  }

  /** Seeds the visible direct children of `parentPath`. */
  setChildren(parentPath: string, nodes: readonly ExplorerNode[]): void {
    this.childLists.set(keyFor(parentPath), [...nodes]);
    for (const node of nodes) {
      this.nodes.set(node.path, node);
    }
  }

  /**
   * Applies one watcher-echo reconciliation for `parentPath`.
   *
   * This is the controller's one-level reconcile against the current on-disk
   * listing, which is exactly what an internal mutation's own watcher hint
   * produces later.
   */
  echoDirectory(
    parentPath: string,
    entries: readonly WorkspaceDirectoryEntry[],
  ): void {
    this.calls.push(`echo:${parentPath}`);
    const outcome = reconcileDirectorySnapshots({
      snapshots: [
        {
          path: parentPath,
          current: this.childrenOf(parentPath),
          entries,
        },
      ],
    });
    this.childLists.set(
      keyFor(parentPath),
      outcome.directories[0]?.children ?? [],
    );
  }

  getState(): ExplorerState {
    return {
      contextId: this.contextId,
      generation: this.generation,
      root: directoryNode(ROOT),
      selectedPath: this.selectedPath,
      inlineEdit: this.inlineEdit,
      rootUnavailable: this.rootUnavailable,
    };
  }

  getSelectedNode(): ExplorerNode | null {
    if (this.selectedPath === null) {
      return null;
    }
    return this.nodes.get(this.selectedPath) ?? null;
  }

  getNode(path: string): ExplorerNode | null {
    return this.nodes.get(path) ?? null;
  }

  getInlineEdit(): InlineEditState | null {
    return this.inlineEdit;
  }

  selectPath(path: string | null): void {
    this.calls.push(`select:${path ?? "none"}`);
    this.selectedPath = path;
  }

  clearSelection(): void {
    this.selectPath(null);
  }

  async expandDirectory(path: string): Promise<void> {
    this.calls.push(`expand:${path}`);
  }

  beginCreate(kind: "file" | "directory", parentPath: string): void {
    this.calls.push(`beginCreate:${kind}:${parentPath}`);
    this.inlineEdit = {
      type: kind === "file" ? "create-file" : "create-folder",
      parentPath,
      draftName: "",
    };
  }

  beginRename(sourcePath: string): void {
    this.calls.push(`beginRename:${sourcePath}`);
    this.inlineEdit = {
      type: "rename",
      sourcePath,
      originalName: leafName(sourcePath),
      draftName: leafName(sourcePath),
    };
  }

  cancelInlineEdit(): void {
    this.calls.push("cancelInlineEdit");
    this.inlineEdit = null;
  }

  applyCreatedEntry(parentPath: string, entry: WorkspaceDirectoryEntry): void {
    this.calls.push(`applyCreated:${parentPath}:${entry.path}`);
    const children = this.childLists.get(keyFor(parentPath));
    const alreadyShown =
      children !== undefined &&
      children.some((node) => node.path === entry.path);
    if (children !== undefined && !alreadyShown) {
      const node = toExplorerNode(entry);
      children.push(node);
      this.nodes.set(node.path, node);
    }
  }

  applyRenamedEntry(request: {
    sourcePath: string;
    newPath: string;
    newName: string;
  }): void {
    this.calls.push(`applyRenamed:${request.sourcePath}->${request.newPath}`);
    const parentPath = parentPathOf(request.sourcePath);
    const children = this.childLists.get(keyFor(parentPath));
    const node = children?.find((child) => child.path === request.sourcePath);
    if (children === undefined || node === undefined) {
      return;
    }

    // The renamed entry keeps its node (and therefore its expansion/cache
    // state); only its path, name and descendants' paths change.
    children.splice(children.indexOf(node), 1);
    rebaseNodePaths(node, request.sourcePath, request.newPath);
    node.name = request.newName;
    children.push(node);
    this.nodes.delete(request.sourcePath);
    this.nodes.set(node.path, node);
  }

  applyDeletedEntry(path: string): void {
    this.calls.push(`applyDeleted:${path}`);
    const children = this.childLists.get(keyFor(parentPathOf(path)));
    if (children === undefined) {
      return;
    }
    const index = children.findIndex((child) => child.path === path);
    if (index >= 0) {
      children.splice(index, 1);
    }
    this.nodes.delete(path);
  }

  async refresh(): Promise<void> {
    this.calls.push("refresh");
  }

  markRootAvailable(): void {
    this.calls.push("markRootAvailable");
    this.rootUnavailable = false;
  }
}

class FakeWorkspaceFileService implements WorkspaceFileService {
  readonly calls: string[] = [];
  /** Relation derivations, kept apart from mutating filesystem calls. */
  readonly relationCalls: Array<{ rootPath: string; targetPath: string }> = [];

  /**
   * Paths that are directories.
   *
   * The real `resolve_workspace_relation` command rejects a non-directory root,
   * so the fake rejects one too; a test that quietly allowed a file root would
   * hide exactly the regression this models.
   */
  private readonly directories = new Set<string>();

  createResult: CreateWorkspaceEntryResult | null = null;
  createError: FileCommandError | null = null;
  renameResult: RenameWorkspaceEntryResult | null = null;
  renameError: FileCommandError | null = null;
  trashError: FileCommandError | null = null;
  relationError: FileCommandError | null = null;
  /** When set, the one-level read fails with it. */
  directoryReadError: FileCommandError | null = null;

  /**
   * One-level directory listings, keyed by the directory path.
   *
   * The pre-mutation source guard reads the source's parent through this map, so
   * a test seeds the *disk* state here and can change it mid-operation to model
   * an external replacement (T116).
   */
  private readonly listings = new Map<string, WorkspaceDirectoryEntry[]>();

  /** Directories the backend reports as comparing names case-sensitively. */
  private readonly caseSensitiveDirectories = new Set<string>();

  /**
   * Directory reads, kept apart from mutating filesystem calls.
   *
   * Existing assertions count `calls` as "what was done to the filesystem", and a
   * read is not a mutation, so the two are recorded separately exactly like
   * `relationCalls`.
   */
  readonly directoryReads: string[] = [];

  addDirectory(path: string): void {
    this.directories.add(keyFor(path));
  }

  isDirectory(path: string): boolean {
    return this.directories.has(keyFor(path));
  }

  /** Seeds the on-disk direct children of `parentPath`. */
  setDirectoryListing(
    parentPath: string,
    entries: readonly WorkspaceDirectoryEntry[],
  ): void {
    this.listings.set(keyFor(parentPath), [...entries]);
  }

  /**
   * Models a directory the real backend reports as case-sensitive.
   *
   * The comparison contract belongs to the backend, so a test has to be able to
   * hand the frontend either answer rather than relying on the host platform.
   */
  setCaseSensitive(parentPath: string, caseSensitive = true): void {
    const key = keyFor(parentPath);
    if (caseSensitive) {
      this.caseSensitiveDirectories.add(key);
    } else {
      this.caseSensitiveDirectories.delete(key);
    }
  }

  /** The current on-disk direct children of `parentPath`. */
  directoryListing(parentPath: string): readonly WorkspaceDirectoryEntry[] {
    return this.listings.get(keyFor(parentPath)) ?? [];
  }

  async readWorkspaceDirectory(
    path: string,
  ): Promise<ReadWorkspaceDirectoryResult> {
    this.directoryReads.push(path);

    if (this.directoryReadError !== null) {
      throw this.directoryReadError;
    }

    const entries = this.listings.get(keyFor(path));
    if (entries === undefined) {
      // The real command rejects a directory it cannot read, and a fixture that
      // silently returned an empty listing would hide the missing seed behind a
      // "entry disappeared" refusal.
      throw {
        code: "io_directory",
        message: `Cannot read ${path}`,
      } satisfies FileCommandError;
    }

    return {
      requestedPath: path,
      canonicalPath: path,
      comparisonKey: keyFor(path),
      caseSensitive: this.caseSensitiveDirectories.has(keyFor(path)),
      entries,
    };
  }

  async createWorkspaceEntry(
    request: CreateWorkspaceEntryRequest,
  ): Promise<CreateWorkspaceEntryResult> {
    this.calls.push(`create:${request.parentPath}:${request.name}:${request.kind}`);
    if (this.createError !== null) {
      throw this.createError;
    }
    return (
      this.createResult ?? {
        path: `${request.parentPath}\\${request.name}`,
        identity: identity(`${request.parentPath}\\${request.name}`),
      }
    );
  }

  async renameWorkspaceEntry(
    request: RenameWorkspaceEntryRequest,
  ): Promise<RenameWorkspaceEntryResult> {
    this.calls.push(`rename:${request.sourcePath}:${request.newName}`);
    if (this.renameError !== null) {
      throw this.renameError;
    }
    const newPath = `${parentPathOf(request.sourcePath)}\\${request.newName}`;
    return (
      this.renameResult ?? {
        oldCanonicalPath: request.sourcePath,
        newPath,
        newIdentity: identity(newPath),
      }
    );
  }

  async trashWorkspaceEntry(path: string): Promise<void> {
    this.calls.push(`trash:${path}`);
    if (this.trashError !== null) {
      throw this.trashError;
    }
  }

  /**
   * Component-aware containment, mirroring what the Rust command answers: the
   * target is `inside` the root only when the root is a directory and every root
   * component matches, so a sibling such as `src2` is never inside `src`.
   */
  async resolveWorkspaceRelation(request: {
    rootPath: string;
    targetPath: string;
  }): Promise<ResolveWorkspaceRelationResult> {
    this.relationCalls.push(request);

    if (this.relationError !== null) {
      throw this.relationError;
    }

    if (!this.isDirectory(request.rootPath)) {
      // `file_identity::resolve_workspace_relation` requires a directory root.
      throw {
        code: "path_resolution",
        message: `Not a directory: ${request.rootPath}`,
      } satisfies FileCommandError;
    }

    const root = components(request.rootPath);
    const target = components(request.targetPath);
    if (target.length < root.length) {
      return { type: "outside" };
    }
    for (const [index, component] of root.entries()) {
      if (component !== target[index]) {
        return { type: "outside" };
      }
    }

    return { type: "inside", relativePath: target.slice(root.length).join("\\") };
  }
}

/** Canonical comparison components of a path, case-folded like Rust's keys. */
function components(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  const source = trimmed === "" ? path : trimmed;
  return source
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((component) => component !== "");
}

class FakeDocuments implements ExplorerDocumentPort {
  readonly calls: string[] = [];

  openResult: OpenPathResult = { status: "opened", documentId: "doc-opened" };
  reserveResult: PathMutationResult | null = null;
  sessions: DocumentSession[] = [];
  removed: string[][] = [];
  readonly renames: CommittedPathRename[] = [];

  async openPath(path: string): Promise<OpenPathResult> {
    this.calls.push(`open:${path}`);
    return this.openResult;
  }

  listSessions(): readonly DocumentSession[] {
    return this.sessions;
  }

  /** Canonical at-or-below candidates, as the document manager reports them. */
  findSessionsUnder(key: string): readonly DocumentSession[] {
    return this.sessions.filter(
      (session) =>
        session.pathIdentity !== null &&
        (session.pathIdentity.comparisonKey === key ||
          session.pathIdentity.comparisonKey.startsWith(`${key}\\`) ||
          session.pathIdentity.comparisonKey.startsWith(`${key}/`)),
    );
  }

  async reservePathMutation(
    request: PathMutationRequest,
  ): Promise<PathMutationResult> {
    this.calls.push(
      `reserve:${request.sourceKey}:${request.destinationKey ?? "none"}`,
    );
    return (
      this.reserveResult ?? {
        status: "reserved",
        reservation: { release: () => this.calls.push("release") },
      }
    );
  }

  commitRenamedPath(request: CommittedPathRename): readonly string[] {
    this.calls.push(`commitRename:${request.newPath}`);
    this.renames.push(request);
    return ["doc-1"];
  }

  removeDeletedSessions(ids: readonly string[]): readonly string[] {
    this.calls.push(`removeDeleted:${ids.join(",")}`);
    this.removed.push([...ids]);
    return ids;
  }
}

class FakeDialogs implements WorkspaceDialogService {
  readonly calls: string[] = [];
  readonly errors: string[] = [];
  /** Answers consumed in order; the last one repeats. */
  deleteAnswers: boolean[] = [true];
  prompts: DeleteConfirmationRequest[] = [];

  async pickWorkspaceFolder(): Promise<string | null> {
    return null;
  }

  async showError(text: string): Promise<void> {
    this.errors.push(text);
    this.calls.push(`error:${text}`);
  }

  async confirmDelete(request: DeleteConfirmationRequest): Promise<boolean> {
    this.prompts.push(request);
    this.calls.push(`confirm:${request.displayName}`);
    const answer =
      this.deleteAnswers.length > 1
        ? this.deleteAnswers.shift()!
        : this.deleteAnswers[0];
    return answer;
  }
}

function identity(
  path: string,
  kind: ResolvedPathIdentity["kind"] = "file",
): ResolvedPathIdentity {
  return {
    requestedPath: path,
    canonicalPath: path,
    comparisonKey: keyFor(path),
    kind,
    diskRevision: { size: 0, modifiedTimeMillis: 0 },
    objectIdentity: kind === "missing" ? null : `fake:${keyFor(path)}`,
  };
}

function session(path: string, dirty: boolean, id = `doc-${leafName(path)}`): DocumentSession {
  return {
    id,
    path,
    pathIdentity: identity(path),
    displayName: leafName(path),
    format: { ...NEW_DOCUMENT_FORMAT },
    dirty,
    savedBaseline: Text.empty,
    editorState: EditorState.create({ doc: "" }),
    viewState: { scrollTop: 0, scrollLeft: 0 },
    latestSaveGeneration: 0,
    externalState: "normal",
    bindingGeneration: 0,
  };
}

interface Harness {
  actions: ExplorerActions;
  explorer: FakeExplorer;
  files: FakeWorkspaceFileService;
  documents: FakeDocuments;
  dialogs: FakeDialogs;
  workContext: WorkContext | null;
}

function createHarness(options: { workspace?: boolean } = {}): Harness {
  const explorer = new FakeExplorer();
  const files = new FakeWorkspaceFileService();
  const documents = new FakeDocuments();
  const dialogs = new FakeDialogs();

  const harness: Harness = {
    actions: null as unknown as ExplorerActions,
    explorer,
    files,
    documents,
    dialogs,
    workContext: options.workspace === false ? null : context(),
  };

  const identityService = {
    inspectFilePath(path: string): Promise<ResolvedPathIdentity> {
      // Directories are reported as such, because the identity's kind decides
      // whether a directory's contents are consulted at all.
      return Promise.resolve(
        identity(path, harness.files.isDirectory(path) ? "directory" : "file"),
      );
    },
  };

  harness.actions = new ExplorerActions({
    explorer,
    workContexts: { getContext: () => harness.workContext },
    workspaceFileService: files,
    documents,
    dialogs,
    fileService: identityService,
  });

  return harness;
}

/**
 * A clean Workspace tree with `src` expanded and `a.ts` inside it.
 *
 * The Tree and the fake's on-disk listings are seeded together, because the
 * pre-mutation source guard compares the two: a fixture whose listing lacked the
 * selected entry would model a replaced object rather than a normal operation.
 */
function withTree(harness: Harness): Harness {
  harness.files.addDirectory(ROOT);
  harness.files.addDirectory(SRC);

  const rootNode = directoryNode(ROOT);
  const srcNode = directoryNode(SRC);
  const fileANode = fileNode(FILE_A);
  const notesNode = fileNode("C:\\work\\notes.txt");

  harness.explorer.nodes.set(ROOT, rootNode);
  harness.explorer.nodes.set(SRC, srcNode);
  harness.explorer.nodes.set(FILE_A, fileANode);
  harness.explorer.nodes.set("C:\\work\\notes.txt", notesNode);
  harness.explorer.setChildren(ROOT, [srcNode, notesNode]);
  harness.explorer.setChildren(SRC, [fileANode]);

  harness.files.setDirectoryListing(ROOT, [
    listEntry(SRC, "directory"),
    listEntry("C:\\work\\notes.txt"),
  ]);
  harness.files.setDirectoryListing(SRC, [listEntry(FILE_A)]);

  return harness;
}

/* -------------------------------------------------------------------------- */
/* Operation context (FR-049..FR-053, FR-075)                                  */
/* -------------------------------------------------------------------------- */

describe("deriveFileOperationContext", () => {
  it("offers nothing without a Workspace", () => {
    const result = deriveFileOperationContext(null, fileNode(FILE_A));

    expect(result).toEqual({
      workContext: null,
      selectedEntry: null,
      createParentPath: null,
      renameTargetPath: null,
      deleteTargetPath: null,
      isRootContext: false,
    });
    expect(isCreateAvailable(result)).toBe(false);
    expect(isRenameAvailable(result)).toBe(false);
    expect(isDeleteAvailable(result)).toBe(false);
    expect(isRefreshAvailable(result)).toBe(false);
  });

  it("uses the Workspace root when no node is selected", () => {
    const result = deriveFileOperationContext(context(), null);

    expect(result.createParentPath).toBe(ROOT);
    expect(result.renameTargetPath).toBeNull();
    expect(result.deleteTargetPath).toBeNull();
    expect(result.isRootContext).toBe(true);
    expect(isCreateAvailable(result)).toBe(true);
    expect(isRefreshAvailable(result)).toBe(true);
  });

  it("treats the root node itself as the root context", () => {
    const result = deriveFileOperationContext(context(), directoryNode(ROOT));

    expect(result.createParentPath).toBe(ROOT);
    expect(result.renameTargetPath).toBeNull();
    expect(result.deleteTargetPath).toBeNull();
    expect(result.isRootContext).toBe(true);
    expect(isRenameAvailable(result)).toBe(false);
    expect(isDeleteAvailable(result)).toBe(false);
  });

  it("targets a selected directory for creation, rename and delete", () => {
    const result = deriveFileOperationContext(context(), directoryNode(SRC));

    expect(result.createParentPath).toBe(SRC);
    expect(result.renameTargetPath).toBe(SRC);
    expect(result.deleteTargetPath).toBe(SRC);
    expect(result.isRootContext).toBe(false);
  });

  it("creates beside a selected file and renames/deletes the file itself", () => {
    const result = deriveFileOperationContext(context(), fileNode(FILE_A));

    expect(result.createParentPath).toBe(SRC);
    expect(result.renameTargetPath).toBe(FILE_A);
    expect(result.deleteTargetPath).toBe(FILE_A);
    expect(isCreateAvailable(result)).toBe(true);
    expect(isRenameAvailable(result)).toBe(true);
    expect(isDeleteAvailable(result)).toBe(true);
  });

  it("derives the parent directory path of a visible entry", () => {
    expect(parentPathOf(FILE_A)).toBe(SRC);
    expect(parentPathOf("C:\\work\\notes.txt")).toBe("C:\\work");
    expect(parentPathOf("C:\\notes.txt")).toBe("C:\\");
    expect(parentPathOf("C:/work/notes.txt")).toBe("C:/work");
    expect(parentPathOf("C:\\work\\src\\")).toBe("C:\\work");
  });
});

describe("ExplorerActions context menus (FR-076, FR-077)", () => {
  it("selects a right-clicked node before resolving the target", () => {
    const harness = withTree(createHarness());

    const result = harness.actions.handleContextMenu(fileNode(FILE_A));

    expect(harness.explorer.selectedPath).toBe(FILE_A);
    expect(result.renameTargetPath).toBe(FILE_A);
    expect(result.deleteTargetPath).toBe(FILE_A);
    expect(result.createParentPath).toBe(SRC);
  });

  it("clears a stale node target when blank space is right-clicked", () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);

    const result = harness.actions.handleContextMenu(null);

    expect(harness.explorer.selectedPath).toBeNull();
    expect(result.isRootContext).toBe(true);
    expect(result.createParentPath).toBe(ROOT);
    // Root context offers no Rename/Delete, so a stale node cannot be targeted.
    expect(result.renameTargetPath).toBeNull();
    expect(result.deleteTargetPath).toBeNull();
  });

  it("reports availability from the current selection", () => {
    const harness = withTree(createHarness());
    expect(harness.actions.isCreateAvailable()).toBe(true);
    expect(harness.actions.isRenameAvailable()).toBe(false);
    expect(harness.actions.isDeleteAvailable()).toBe(false);

    harness.explorer.selectPath(FILE_A);
    expect(harness.actions.isRenameAvailable()).toBe(true);
    expect(harness.actions.isDeleteAvailable()).toBe(true);
    expect(harness.actions.isRefreshAvailable()).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Context-menu creation scope (FR-006..FR-010, SR-002)                        */
/* -------------------------------------------------------------------------- */

describe("isContextMenuCreateAvailable (US2)", () => {
  it("offers nothing without a Workspace", () => {
    const result = deriveFileOperationContext(null, null);

    expect(isContextMenuCreateAvailable(result)).toBe(false);
  });

  it("offers creation for the Workspace root and for blank space", () => {
    // No concrete selection is the blank-space / root context.
    expect(
      isContextMenuCreateAvailable(deriveFileOperationContext(context(), null)),
    ).toBe(true);

    // The root node itself is still the root context.
    expect(
      isContextMenuCreateAvailable(
        deriveFileOperationContext(context(), directoryNode(ROOT)),
      ),
    ).toBe(true);
  });

  it("offers creation for a selected directory", () => {
    const result = deriveFileOperationContext(context(), directoryNode(SRC));

    expect(isContextMenuCreateAvailable(result)).toBe(true);
    expect(result.createParentPath).toBe(SRC);
  });

  it("hides creation for a selected file but keeps the shared parent target", () => {
    const result = deriveFileOperationContext(context(), fileNode(FILE_A));

    // Only the file context-menu surface loses the two creation items...
    expect(isContextMenuCreateAvailable(result)).toBe(false);
    // ...while 003's target model is untouched: the selected file's parent stays
    // the creation target for the Explorer header (FR-009, SR-002).
    expect(result.createParentPath).toBe(parentPathOf(FILE_A));
    expect(isCreateAvailable(result)).toBe(true);
  });

  it("separates the menu surface from the header surface", () => {
    const harness = withTree(createHarness());

    // Directory and root contexts keep creation in the menu.
    expect(
      isContextMenuCreateAvailable(
        harness.actions.handleContextMenu(directoryNode(SRC)),
      ),
    ).toBe(true);
    expect(
      isContextMenuCreateAvailable(harness.actions.handleContextMenu(null)),
    ).toBe(true);

    // Right-clicking a file selects it and hides creation from its menu.
    const fileContext = harness.actions.handleContextMenu(fileNode(FILE_A));
    expect(harness.explorer.selectedPath).toBe(FILE_A);
    expect(isContextMenuCreateAvailable(fileContext)).toBe(false);

    // The header keeps both its availability rule and its parent target.
    expect(harness.actions.isCreateAvailable()).toBe(true);
    expect(harness.actions.contextFor().createParentPath).toBe(SRC);
  });
});

/* -------------------------------------------------------------------------- */
/* Create (FR-054..FR-057)                                                     */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions create (US5)", () => {
  it("starts the inline editor in the selected directory", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(SRC);

    await harness.actions.newFile();

    expect(harness.explorer.inlineEdit).toEqual({
      type: "create-file",
      parentPath: SRC,
      draftName: "",
    });
    // The target directory is expanded so the editor is visible.
    expect(harness.explorer.calls).toContain(`expand:${SRC}`);
  });

  it("creates beside a selected file", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);

    await harness.actions.newFolder();
    harness.explorer.inlineEdit = {
      type: "create-folder",
      parentPath: SRC,
      draftName: "",
    };
    harness.explorer.getInlineEdit = () => ({
      type: "create-folder",
      parentPath: SRC,
      draftName: "nested",
    });

    await harness.actions.commitInlineEdit();

    expect(harness.files.calls).toEqual([`create:${SRC}:nested:directory`]);
    // A new folder is selected but never opened as a document (FR-056).
    expect(harness.explorer.calls).toContain("applyCreated:" + SRC + ":" + SRC + "\\nested");
    // Creation reserves its destination before writing, exactly like every other
    // path transition (FR-100, plan decision 15).
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(`${SRC}\\nested`)}:none`,
      "release",
    ]);
  });

  it("creates an entry at the Workspace root without a selection", async () => {
    const harness = withTree(createHarness());
    harness.explorer.getInlineEdit = () => ({
      type: "create-file",
      parentPath: ROOT,
      draftName: "new.txt",
    });

    await harness.actions.commitInlineEdit();

    expect(harness.files.calls).toEqual([`create:${ROOT}:new.txt:file`]);
  });

  it("selects and opens a newly created file", async () => {
    const harness = withTree(createHarness());
    harness.explorer.getInlineEdit = () => ({
      type: "create-file",
      parentPath: SRC,
      draftName: "fresh.ts",
    });

    await harness.actions.commitInlineEdit();

    const createdPath = `${SRC}\\fresh.ts`;
    expect(harness.explorer.calls).toContain(`applyCreated:${SRC}:${createdPath}`);
    expect(harness.explorer.calls).toContain(`select:${createdPath}`);
    expect(harness.explorer.calls).toContain("cancelInlineEdit");
    // The destination is reserved while the file is being created, and the
    // created file then opens through the ordinary document pipeline (FR-055).
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(createdPath)}:none`,
      "release",
      `open:${createdPath}`,
    ]);
  });

  it("keeps the draft and reports when creation fails", async () => {
    const harness = withTree(createHarness());
    harness.files.createError = {
      code: "io_create",
      message: "Already exists: C:\\work\\src\\taken.ts",
    };
    harness.explorer.inlineEdit = {
      type: "create-file",
      parentPath: SRC,
      draftName: "taken.ts",
    };

    await harness.actions.commitInlineEdit();

    expect(harness.dialogs.errors).toEqual([
      "Already exists: C:\\work\\src\\taken.ts",
    ]);
    // Nothing successful-looking is committed.
    expect(harness.explorer.calls).not.toContain("cancelInlineEdit");
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyCreated")),
    ).toBe(false);
    // The reservation is given back even though creation failed.
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(`${SRC}\\taken.ts`)}:none`,
      "release",
    ]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("refuses creation when the destination is already reserved", async () => {
    const harness = withTree(createHarness());
    harness.documents.reserveResult = {
      status: "failed",
      error: {
        code: "path_resolution",
        message: "That destination is already being changed by another operation.",
      },
    };
    harness.explorer.inlineEdit = {
      type: "create-file",
      parentPath: SRC,
      draftName: "taken.ts",
    };

    await harness.actions.commitInlineEdit();

    expect(harness.dialogs.errors).toEqual([
      "That destination is already being changed by another operation.",
    ]);
    // Nothing is created, nothing is committed, and the draft survives.
    expect(harness.files.calls).toEqual([]);
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(`${SRC}\\taken.ts`)}:none`,
    ]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("creates nothing for an empty draft", async () => {    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "create-file",
      parentPath: SRC,
      draftName: "   ",
    };

    await harness.actions.commitInlineEdit();

    expect(harness.files.calls).toEqual([]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("does nothing without a Workspace", async () => {
    const harness = withTree(createHarness({ workspace: false }));

    await harness.actions.newFile();
    await harness.actions.newFolder();

    expect(harness.explorer.inlineEdit).toBeNull();
    expect(harness.explorer.calls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Inline commit results (FR-013..FR-016)                                      */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions inline commit results (US3)", () => {
  it("retains an empty create draft without a filesystem call", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "create-file",
      parentPath: SRC,
      draftName: "   ",
    };

    const result = await harness.actions.commitInlineEdit();

    expect(result).toBe("retained");
    expect(harness.files.calls).toEqual([]);
    expect(harness.documents.calls).toEqual([]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("retains the draft when creation fails on disk", async () => {
    const harness = withTree(createHarness());
    harness.files.createError = {
      code: "io_create",
      message: "Already exists: C:\\work\\src\\taken.ts",
    };
    harness.explorer.inlineEdit = {
      type: "create-file",
      parentPath: SRC,
      draftName: "taken.ts",
    };

    const result = await harness.actions.commitInlineEdit();

    expect(result).toBe("retained");
    // The failure path still reserves and releases the destination, so the
    // result signal cannot have short-circuited the existing orchestration.
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(`${SRC}\\taken.ts`)}:none`,
      "release",
    ]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
    expect(harness.explorer.calls).not.toContain("cancelInlineEdit");
  });

  it("reports a successful create as committed", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "create-file",
      parentPath: SRC,
      draftName: "fresh.ts",
    };

    const result = await harness.actions.commitInlineEdit();

    const createdPath = `${SRC}\\fresh.ts`;
    expect(result).toBe("committed");
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(createdPath)}:none`,
      "release",
      `open:${createdPath}`,
    ]);
    expect(harness.explorer.calls).toContain("cancelInlineEdit");
    expect(harness.explorer.inlineEdit).toBeNull();
  });

  it("retains the draft when the rename fails on disk", async () => {
    const harness = withTree(createHarness());
    harness.files.renameError = {
      code: "io_rename",
      message: "Already exists: C:\\work\\src\\taken.ts",
    };
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "taken.ts",
    };

    const result = await harness.actions.commitInlineEdit();

    expect(result).toBe("retained");
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:${keyFor(`${SRC}\\taken.ts`)}`,
      "release",
    ]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("reports a successful rename as committed", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "renamed.ts",
    };

    const result = await harness.actions.commitInlineEdit();

    const newPath = `${SRC}\\renamed.ts`;
    expect(result).toBe("committed");
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:${keyFor(newPath)}`,
      `commitRename:${newPath}`,
      "release",
    ]);
    expect(harness.explorer.calls).toContain(
      `applyRenamed:${FILE_A}->${newPath}`,
    );
  });

  it("reports an unchanged or empty rename as committed because the editor closes", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "a.ts",
    };

    expect(await harness.actions.commitInlineEdit()).toBe("committed");
    expect(harness.files.calls).toEqual([]);
    expect(harness.explorer.inlineEdit).toBeNull();

    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "  ",
    };

    expect(await harness.actions.commitInlineEdit()).toBe("committed");
    expect(harness.files.calls).toEqual([]);
    expect(harness.explorer.inlineEdit).toBeNull();
  });

  it("retains the draft when the destination is already reserved", async () => {
    const harness = withTree(createHarness());
    harness.documents.reserveResult = {
      status: "failed",
      error: {
        code: "path_resolution",
        message: "That destination is already being changed by another operation.",
      },
    };
    harness.explorer.inlineEdit = {
      type: "create-folder",
      parentPath: SRC,
      draftName: "nested",
    };

    const result = await harness.actions.commitInlineEdit();

    expect(result).toBe("retained");
    expect(harness.files.calls).toEqual([]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Rename (FR-058..FR-064, FR-098, FR-103)                                     */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions rename (US6)", () => {
  it("starts inline rename for the selected non-root entry only", () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(ROOT);

    harness.actions.rename();
    expect(harness.explorer.inlineEdit).toBeNull();

    harness.explorer.selectPath(FILE_A);
    harness.actions.rename();

    expect(harness.explorer.inlineEdit).toEqual({
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "a.ts",
    });
  });

  it("renames on disk before committing document paths or the Tree", async () => {
    const harness = withTree(createHarness());
    harness.explorer.getInlineEdit = () => ({
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "renamed.ts",
    });

    await harness.actions.commitInlineEdit();

    const newPath = `${SRC}\\renamed.ts`;
    expect(harness.files.calls).toEqual([`rename:${FILE_A}:renamed.ts`]);
    // Reservation first, then disk, then document paths, then the Tree.
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:${keyFor(newPath)}`,
      `commitRename:${newPath}`,
      "release",
    ]);
    expect(harness.explorer.calls).toContain(`applyRenamed:${FILE_A}->${newPath}`);
    expect(harness.explorer.calls).toContain(`select:${newPath}`);
  });

  it("rejects a destination another live session owns", async () => {
    const harness = withTree(createHarness());
    harness.documents.reserveResult = {
      status: "failed",
      error: {
        code: "path_resolution",
        message: "That name is already open in another tab.",
      },
    };
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "renamed.ts",
    };

    await harness.actions.commitInlineEdit();

    expect(harness.dialogs.errors).toEqual([
      "That name is already open in another tab.",
    ]);
    // No disk rename, no document path change, no Tree change (FR-063, FR-064).
    expect(harness.files.calls).toEqual([]);
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:${keyFor(SRC + "\\renamed.ts")}`,
    ]);
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyRenamed")),
    ).toBe(false);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("commits nothing when the disk rename fails", async () => {
    const harness = withTree(createHarness());
    harness.files.renameError = {
      code: "io_rename",
      message: "Already exists: C:\\work\\src\\taken.ts",
    };
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "taken.ts",
    };

    await harness.actions.commitInlineEdit();

    expect(harness.dialogs.errors).toEqual([
      "Already exists: C:\\work\\src\\taken.ts",
    ]);
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:${keyFor(SRC + "\\taken.ts")}`,
      "release",
    ]);
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyRenamed")),
    ).toBe(false);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("releases the reservation even when the rename throws", async () => {
    const harness = withTree(createHarness());
    harness.files.renameError = { code: "io_rename", message: "boom" };
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "other.ts",
    };

    await harness.actions.commitInlineEdit();

    expect(harness.documents.calls).toContain("release");
  });

  it("cancels an unchanged or empty rename without touching the filesystem", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "a.ts",
    };

    await harness.actions.commitInlineEdit();
    expect(harness.files.calls).toEqual([]);
    expect(harness.explorer.calls).toContain("cancelInlineEdit");

    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "  ",
    };
    await harness.actions.commitInlineEdit();
    expect(harness.files.calls).toEqual([]);
  });

  it("does not mutate a replaced Explorer tree but still follows the disk rename", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "renamed.ts",
    };

    // The Workspace is replaced while the rename is in flight.
    const originalRename = harness.files.renameWorkspaceEntry.bind(
      harness.files,
    );
    harness.files.renameWorkspaceEntry = async (request) => {
      harness.explorer.generation += 1;
      return originalRename(request);
    };

    await harness.actions.commitInlineEdit();

    // Document paths follow the disk truth...
    expect(harness.documents.calls).toContain(`commitRename:${SRC}\\renamed.ts`);
    // ...but the new context's tree is never mutated with a stale result.
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyRenamed")),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Deferred continuations (FR-030, FR-089)                                     */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions deferred continuations (FR-030, FR-089)", () => {
  /** Simulates the user opening another Workspace while an action is in flight. */
  function replaceWorkspace(harness: ReturnType<typeof createHarness>): void {
    harness.explorer.contextId = "workspace-2";
    harness.explorer.generation += 1;
  }

  it("does not open the create editor in a Workspace that replaced the old one", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(SRC);

    const expand = harness.explorer.expandDirectory.bind(harness.explorer);
    harness.explorer.expandDirectory = async (path) => {
      await expand(path);
      // The directory read was awaited, and the Workspace changed meanwhile.
      replaceWorkspace(harness);
    };

    await harness.actions.newFile();

    // The expansion happened, but the new Tree was neither re-selected nor given
    // an inline editor that belongs to the old context (FR-030, FR-089).
    expect(harness.explorer.calls).toEqual([`select:${SRC}`, `expand:${SRC}`]);
    expect(harness.explorer.inlineEdit).toBeNull();
  });

  it("opens a created file without reconciling the replaced Tree", async () => {
    const harness = withTree(createHarness());
    harness.explorer.getInlineEdit = () => ({
      type: "create-file",
      parentPath: SRC,
      draftName: "fresh.ts",
    });

    const create = harness.files.createWorkspaceEntry.bind(harness.files);
    harness.files.createWorkspaceEntry = async (request) => {
      replaceWorkspace(harness);
      return create(request);
    };

    await harness.actions.commitInlineEdit();

    const createdPath = `${SRC}\\fresh.ts`;
    // The entry exists on disk and opens as a document, because documents do not
    // belong to a Workspace (FR-010, FR-055).
    expect(harness.files.calls).toEqual([`create:${SRC}:fresh.ts:file`]);
    expect(harness.documents.calls).toContain(`open:${createdPath}`);
    // No node, selection or inline-edit change reaches the new Tree.
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyCreated")),
    ).toBe(false);
    expect(harness.explorer.calls).not.toContain(`select:${createdPath}`);
    expect(harness.explorer.calls).not.toContain("cancelInlineEdit");
  });

  it("follows the disk rename without touching a replaced Tree", async () => {
    const harness = withTree(createHarness());
    harness.explorer.getInlineEdit = () => ({
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "renamed.ts",
    });

    const rename = harness.files.renameWorkspaceEntry.bind(harness.files);
    harness.files.renameWorkspaceEntry = async (request) => {
      replaceWorkspace(harness);
      return rename(request);
    };

    await harness.actions.commitInlineEdit();

    const newPath = `${SRC}\\renamed.ts`;
    // The moved file's document path is committed...
    expect(harness.documents.calls).toContain(`commitRename:${newPath}`);
    // ...while the replaced Tree receives none of the old context's changes.
    expect(
      harness.explorer.calls.some(
        (call) =>
          call.startsWith("applyRenamed") || call === `select:${newPath}`,
      ),
    ).toBe(false);
    expect(harness.explorer.calls).not.toContain("cancelInlineEdit");
  });
});

/* -------------------------------------------------------------------------- */
/* Delete (FR-065..FR-074, FR-098, FR-103)                                     */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions delete (US7)", () => {
  it("does nothing when no deletable entry is selected", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(ROOT);

    await harness.actions.delete();

    expect(harness.dialogs.prompts).toEqual([]);
    expect(harness.files.calls).toEqual([]);
  });

  it("trashes a clean, unopened target after confirmation", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath("C:\\work\\notes.txt");

    await harness.actions.delete();

    expect(harness.dialogs.prompts).toEqual([
      { displayName: "notes.txt", dirty: false, affectedDirtyNames: [] },
    ]);
    expect(harness.files.calls).toEqual(["trash:C:\\work\\notes.txt"]);
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor("C:\\work\\notes.txt")}:none`,
      "removeDeleted:",
      "release",
    ]);
    expect(harness.explorer.calls).toContain(
      "applyDeleted:C:\\work\\notes.txt",
    );
  });

  it("changes nothing when the confirmation is cancelled", async () => {
    const harness = withTree(createHarness());
    harness.dialogs.deleteAnswers = [false];
    harness.explorer.selectPath(FILE_A);

    await harness.actions.delete();

    // Even with a cancellation the reservation is given back.
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:none`,
      "release",
    ]);
    expect(harness.files.calls).toEqual([]);
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyDeleted")),
    ).toBe(false);
  });

  it("warns about unsaved work in an open target and removes it without a second prompt", async () => {
    const harness = withTree(createHarness());
    harness.documents.sessions = [session(FILE_A, true)];
    harness.explorer.selectPath(FILE_A);

    await harness.actions.delete();

    expect(harness.dialogs.prompts[0]).toEqual({
      displayName: "a.ts",
      dirty: true,
      affectedDirtyNames: [],
    });
    expect(harness.files.calls).toEqual([`trash:${FILE_A}`]);
    // The session is removed through the no-second-prompt API (FR-071).
    expect(harness.documents.removed).toEqual([[`doc-a.ts`]]);
    expect(harness.documents.calls).toContain("removeDeleted:doc-a.ts");
  });

  it("warns about the dirty documents inside a deleted directory", async () => {
    const harness = withTree(createHarness());
    harness.documents.sessions = [
      session(FILE_A, true, "doc-a"),
      session(`${SRC}\\b.ts`, false, "doc-b"),
    ];
    harness.explorer.selectPath(SRC);

    await harness.actions.delete();

    expect(harness.dialogs.prompts[0]).toEqual({
      displayName: "src",
      dirty: false,
      affectedDirtyNames: ["a.ts"],
    });
    expect(harness.documents.removed).toEqual([["doc-a", "doc-b"]]);
  });

  it("asks again when a target becomes dirty while the dialog is open", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);

    const confirmDelete = harness.dialogs.confirmDelete.bind(harness.dialogs);
    harness.dialogs.confirmDelete = async (request) => {
      // The document becomes dirty while the user is deciding.
      harness.documents.sessions = [session(FILE_A, true)];
      return confirmDelete(request);
    };

    await harness.actions.delete();

    expect(harness.dialogs.prompts).toHaveLength(2);
    expect(harness.dialogs.prompts[0].dirty).toBe(false);
    expect(harness.dialogs.prompts[1].dirty).toBe(true);
  });

  it("aborts when the repeated warning is declined", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);
    harness.dialogs.deleteAnswers = [true, false];

    const confirmDelete = harness.dialogs.confirmDelete.bind(harness.dialogs);
    harness.dialogs.confirmDelete = async (request) => {
      harness.documents.sessions = [session(FILE_A, true)];
      return confirmDelete(request);
    };

    await harness.actions.delete();

    expect(harness.files.calls).toEqual([]);
    expect(harness.documents.removed).toEqual([]);
  });

  it("leaves Tabs and Tree intact when the trash operation fails", async () => {
    const harness = withTree(createHarness());
    harness.files.trashError = {
      code: "io_trash",
      message: "Cannot move to the recycle bin",
    };
    harness.documents.sessions = [session(FILE_A, false, "doc-a")];
    harness.explorer.selectPath(FILE_A);

    await harness.actions.delete();

    expect(harness.dialogs.errors).toEqual(["Cannot move to the recycle bin"]);
    expect(harness.documents.removed).toEqual([]);
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyDeleted")),
    ).toBe(false);
  });

  it("refuses to start when the source cannot be resolved", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);
    harness.actions = new ExplorerActions({
      explorer: harness.explorer,
      workContexts: { getContext: () => harness.workContext },
      workspaceFileService: harness.files,
      documents: harness.documents,
      dialogs: harness.dialogs,
      fileService: {
        inspectFilePath: () =>
          Promise.reject({
            code: "path_resolution",
            message: "Path does not exist",
          }),
      },
    });

    await harness.actions.delete();

    expect(harness.dialogs.prompts).toEqual([]);
    expect(harness.dialogs.errors).toEqual(["Path does not exist"]);
  });

  it("does not mutate a replaced Explorer tree after a successful trash", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);

    const trash = harness.files.trashWorkspaceEntry.bind(harness.files);
    harness.files.trashWorkspaceEntry = async (path) => {
      harness.explorer.generation += 1;
      return trash(path);
    };

    await harness.actions.delete();

    expect(harness.files.calls).toContain(`trash:${FILE_A}`);
    expect(
      harness.explorer.calls.some((call) => call.startsWith("applyDeleted")),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Internal mutation race hardening (T116, T117, T118, T119)                   */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions source identity guard (T116, T117, T118)", () => {
  /** Opens the inline Rename editor for `a.ts`, as the controller does. */
  function beginRename(harness: Harness, draftName: string): void {
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName,
    };
  }

  /** Swaps the object at the source path, as another process would. */
  function replaceSource(harness: Harness): void {
    harness.files.setDirectoryListing(SRC, [
      replacedEntry(FILE_A, "fake:replacement"),
    ]);
  }

  const renameCalls = [
    `reserve:${keyFor(FILE_A)}:${keyFor(`${SRC}\\renamed.ts`)}`,
    "release",
  ];

  it("refuses to rename a source replaced while the reservation settled", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");

    // The reservation is the awaited path coordination step; the replacement
    // lands while the operation is suspended there.
    const reserve =
      harness.documents.reservePathMutation.bind(harness.documents);
    harness.documents.reservePathMutation = async (request) => {
      replaceSource(harness);
      return reserve(request);
    };
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");

    const result = await harness.actions.commitInlineEdit();

    // The draft survives so the user can retry once the Tree has converged...
    expect(result).toBe("retained");
    // ...but the replaced object is never renamed, and neither document paths
    // nor the Tree changed.
    expect(rename).not.toHaveBeenCalled();
    expect(harness.documents.renames).toEqual([]);
    expect(harness.explorer.calls).toEqual([]);
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
    // The reservation taken before the check is given back exactly like the
    // existing failure paths, and the parent directory was the source of truth.
    expect(harness.documents.calls).toEqual(renameCalls);
    expect(harness.files.directoryReads).toEqual([SRC]);
    expect(harness.explorer.inlineEdit).not.toBeNull();
  });

  it("still renames when only the on-disk leaf casing changed", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");

    // The source directory reports a case-*insensitive* contract, which is what
    // makes a folded fallback legitimate here at all (T156).
    await expect(
      harness.files.readWorkspaceDirectory(SRC),
    ).resolves.toMatchObject({ caseSensitive: false });

    // An unreconciled case-only external rename: the Tree still spells `a.ts`
    // while the listing now reports `A.TS`. The object is the *same* one — its
    // token is unchanged — so refusing here would be a false negative (FR-066).
    harness.files.setDirectoryListing(SRC, [movedEntry(FILE_A, `${SRC}\\A.TS`)]);

    const result = await harness.actions.commitInlineEdit();

    expect(result).toBe("committed");
    expect(harness.files.calls).toContain(`rename:${FILE_A}:renamed.ts`);
    expect(harness.documents.renames).toHaveLength(1);
    expect(harness.dialogs.errors).toEqual([]);
  });

  it("refuses to rename a source whose fresh identity is unavailable", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");
    // The replacement entry carries no token, so continuity cannot be proven.
    harness.files.setDirectoryListing(SRC, [replacedEntry(FILE_A, null)]);
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");

    expect(await harness.actions.commitInlineEdit()).toBe("retained");

    expect(rename).not.toHaveBeenCalled();
    expect(harness.documents.renames).toEqual([]);
    expect(harness.explorer.calls).toEqual([]);
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
    expect(harness.documents.calls).toEqual(renameCalls);
  });

  it("refuses to rename a source that disappeared from its parent", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");
    harness.files.setDirectoryListing(SRC, []);
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");

    expect(await harness.actions.commitInlineEdit()).toBe("retained");

    expect(rename).not.toHaveBeenCalled();
    expect(harness.documents.renames).toEqual([]);
    expect(harness.explorer.calls).toEqual([]);
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
    expect(harness.documents.calls).toEqual(renameCalls);
  });

  it("refuses to rename a source whose kind changed", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");
    // A directory now occupies the path with a different token: the entry was
    // replaced even though the path string is unchanged.
    harness.files.setDirectoryListing(SRC, [
      replacedEntry(FILE_A, "fake:replacement-directory", "directory"),
    ]);
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");

    expect(await harness.actions.commitInlineEdit()).toBe("retained");

    expect(rename).not.toHaveBeenCalled();
    expect(harness.explorer.calls).toEqual([]);
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
  });

  it("refuses to trash a target replaced while the user was deciding", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);
    harness.documents.sessions = [session(FILE_A, false, "doc-a")];

    // The confirmation dialog is the awaited step the user decides in; the
    // replacement lands before they answer.
    const confirmDelete = harness.dialogs.confirmDelete.bind(harness.dialogs);
    harness.dialogs.confirmDelete = async (request) => {
      replaceSource(harness);
      return confirmDelete(request);
    };
    const trash = vi.spyOn(harness.files, "trashWorkspaceEntry");

    await harness.actions.delete();

    expect(trash).not.toHaveBeenCalled();
    // No session was removed and the Tree kept its node.
    expect(harness.documents.removed).toEqual([]);
    expect(harness.explorer.calls).toEqual([`select:${FILE_A}`]);
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:none`,
      "release",
    ]);
    expect(harness.files.directoryReads).toEqual([SRC]);
  });

  it("refuses both operations when the captured entry identity is unavailable", async () => {
    const harness = withTree(createHarness());
    // The platform supplied no token for the selected node, so continuity is
    // unprovable even though the fresh listing would match by path and kind.
    const anonymous = { ...fileNode(FILE_A), objectIdentity: null };
    harness.explorer.nodes.set(FILE_A, anonymous);
    harness.explorer.setChildren(SRC, [anonymous]);

    beginRename(harness, "renamed.ts");
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");
    expect(await harness.actions.commitInlineEdit()).toBe("retained");
    expect(rename).not.toHaveBeenCalled();
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
    expect(harness.explorer.calls).toEqual([]);

    // Delete is refused the same way: the confirmation still runs (it is what
    // the user asked for), but the destructive call does not.
    const deleteHarness = withTree(createHarness());
    deleteHarness.explorer.nodes.set(FILE_A, {
      ...fileNode(FILE_A),
      objectIdentity: null,
    });
    deleteHarness.explorer.selectedPath = FILE_A;
    const trash = vi.spyOn(deleteHarness.files, "trashWorkspaceEntry");

    await deleteHarness.actions.delete();

    expect(trash).not.toHaveBeenCalled();
    expect(deleteHarness.documents.removed).toEqual([]);
    expect(deleteHarness.explorer.calls).toEqual([]);
    expect(deleteHarness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
  });

  it("refuses the mutation when the pre-mutation directory read fails", async () => {
    const readError = {
      code: "io_directory",
      message: "Cannot read the directory",
    } satisfies FileCommandError;

    const renameHarness = withTree(createHarness());
    beginRename(renameHarness, "renamed.ts");
    renameHarness.files.directoryReadError = readError;
    const rename = vi.spyOn(renameHarness.files, "renameWorkspaceEntry");

    expect(await renameHarness.actions.commitInlineEdit()).toBe("retained");

    expect(rename).not.toHaveBeenCalled();
    expect(renameHarness.dialogs.errors).toEqual([readError.message]);
    expect(renameHarness.explorer.calls).toEqual([]);
    expect(renameHarness.documents.calls).toEqual(renameCalls);

    const deleteHarness = withTree(createHarness());
    deleteHarness.explorer.selectedPath = FILE_A;
    deleteHarness.files.directoryReadError = readError;
    const trash = vi.spyOn(deleteHarness.files, "trashWorkspaceEntry");

    await deleteHarness.actions.delete();

    expect(trash).not.toHaveBeenCalled();
    expect(deleteHarness.documents.removed).toEqual([]);
    expect(deleteHarness.explorer.calls).toEqual([]);
    expect(deleteHarness.dialogs.errors).toEqual([readError.message]);
  });

  it("renames a stable source through the unchanged disk-first path", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");

    expect(await harness.actions.commitInlineEdit()).toBe("committed");

    const newPath = `${SRC}\\renamed.ts`;
    expect(rename).toHaveBeenCalledWith({
      sourcePath: FILE_A,
      newName: "renamed.ts",
    });
    expect(harness.dialogs.errors).toEqual([]);
    // Reservation first, then disk, then document paths, then the Tree.
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(FILE_A)}:${keyFor(newPath)}`,
      `commitRename:${newPath}`,
      "release",
    ]);
    expect(harness.explorer.calls).toContain(
      `applyRenamed:${FILE_A}->${newPath}`,
    );
    expect(harness.explorer.calls).toContain(`select:${newPath}`);
    // The guard's one authoritative read was the source's parent, taken last.
    expect(harness.files.directoryReads).toEqual([SRC]);
    expect(childPaths(harness.explorer, SRC)).toEqual([newPath]);
  });

  it("trashes a stable target and keeps the 003 dirty warning semantics", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath(FILE_A);
    harness.documents.sessions = [session(FILE_A, true, "doc-a")];
    const trash = vi.spyOn(harness.files, "trashWorkspaceEntry");

    await harness.actions.delete();

    expect(trash).toHaveBeenCalledWith(FILE_A);
    // One warning for a confirmed clean operation, and the dirty Tab is removed
    // through the no-second-prompt API (FR-069, FR-071).
    expect(harness.dialogs.prompts).toEqual([
      { displayName: "a.ts", dirty: true, affectedDirtyNames: [] },
    ]);
    expect(harness.documents.removed).toEqual([["doc-a"]]);
    expect(harness.explorer.calls).toContain(`applyDeleted:${FILE_A}`);
    expect(harness.dialogs.errors).toEqual([]);
    expect(harness.files.directoryReads).toEqual([SRC]);
  });

  it("converges to the on-disk listing after a rename and its watcher echoes", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");

    await harness.actions.commitInlineEdit();

    const newPath = `${SRC}\\renamed.ts`;
    expect(childPaths(harness.explorer, SRC)).toEqual([newPath]);

    // The watcher later reports the very same on-disk structure, twice. A
    // rename preserves the object's token, so this is the same entry, not a
    // delete/recreate pair.
    harness.files.setDirectoryListing(SRC, [movedEntry(FILE_A, newPath)]);
    harness.explorer.echoDirectory(SRC, harness.files.directoryListing(SRC));
    harness.explorer.echoDirectory(SRC, harness.files.directoryListing(SRC));

    expect(childPaths(harness.explorer, SRC)).toEqual([newPath]);
    expect(harness.explorer.childrenOf(SRC)).toHaveLength(1);
  });

  it("converges to the on-disk listing after a delete and its watcher echoes", async () => {
    const harness = withTree(createHarness());
    harness.explorer.selectPath("C:\\work\\notes.txt");

    await harness.actions.delete();

    expect(childPaths(harness.explorer, ROOT)).toEqual([SRC]);

    // The echo repeats the current on-disk structure: the entry is gone.
    harness.files.setDirectoryListing(ROOT, [listEntry(SRC, "directory")]);
    harness.explorer.echoDirectory(ROOT, harness.files.directoryListing(ROOT));
    harness.explorer.echoDirectory(ROOT, harness.files.directoryListing(ROOT));

    expect(childPaths(harness.explorer, ROOT)).toEqual([SRC]);
    expect(harness.explorer.childrenOf(ROOT)).toHaveLength(1);
  });
  it("prefers the exact leaf over a case-colliding sibling with the same identity", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");

    // A case-sensitive filesystem with two case-distinct hardlinks to one object:
    // only the entry the user actually selected may be renamed.
    harness.files.setDirectoryListing(SRC, [
      movedEntry(FILE_A, FILE_A),
      movedEntry(FILE_A, `${SRC}\\A.TS`),
    ]);

    expect(await harness.actions.commitInlineEdit()).toBe("committed");
    expect(harness.files.calls).toContain(`rename:${FILE_A}:renamed.ts`);
  });

  it("refuses an ambiguous case-folded match instead of guessing", async () => {
    const harness = withTree(createHarness());
    beginRename(harness, "renamed.ts");

    // The selected spelling is absent, and it folds onto two case-distinct
    // entries that share one object identity: there is no way to tell which one
    // the user meant, so the mutation is refused (Constitution I).
    harness.files.setDirectoryListing(SRC, [
      movedEntry("C:\\work\\src\\SHARED-X", `${SRC}\\A.TS`),
      movedEntry("C:\\work\\src\\SHARED-X", `${SRC}\\a.ts`),
    ]);
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");

    expect(await harness.actions.commitInlineEdit()).toBe("retained");
    expect(rename).not.toHaveBeenCalled();
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
  });
});

/* -------------------------------------------------------------------------- */
/* Refresh (FR-082, FR-083)                                                    */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions refresh (US9)", () => {
  it("runs the same loaded-tree refresh from any context", async () => {
    const harness = withTree(createHarness());

    await harness.actions.refresh();
    expect(harness.explorer.calls).toEqual(["refresh"]);

    // Root context and directory context reach the same operation.
    harness.explorer.selectedPath = SRC;
    expect(harness.actions.contextFor().deleteTargetPath).toBe(SRC);
    expect(harness.actions.isRefreshAvailable()).toBe(true);
    await harness.actions.refresh();
    expect(harness.explorer.calls).toEqual(["refresh", "refresh"]);
  });

  it("reports refresh as unavailable without a Workspace", () => {
    const harness = withTree(createHarness({ workspace: false }));

    expect(harness.actions.isRefreshAvailable()).toBe(false);
  });

  it("offers context-menu Refresh for root and directory targets only", () => {
    const harness = withTree(createHarness());

    // No concrete node selected: the Workspace-root context.
    expect(harness.actions.isContextMenuRefreshAvailable()).toBe(true);

    // The root node itself is still the root context.
    harness.explorer.selectedPath = ROOT;
    expect(harness.actions.isContextMenuRefreshAvailable()).toBe(true);

    // A directory context keeps Refresh.
    harness.explorer.selectedPath = SRC;
    expect(harness.actions.isContextMenuRefreshAvailable()).toBe(true);

    // A file context offers creation, Rename and Delete only (plan decision 12),
    // while the header Refresh stays available for the loaded tree.
    harness.explorer.selectedPath = FILE_A;
    expect(harness.actions.isContextMenuRefreshAvailable()).toBe(false);
    expect(harness.actions.isRefreshAvailable()).toBe(true);
  });

  it("offers no context-menu Refresh without a Workspace", () => {
    const harness = withTree(createHarness({ workspace: false }));

    expect(harness.actions.isContextMenuRefreshAvailable()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Relation-derived containment (FR-041..FR-043)                               */
/* -------------------------------------------------------------------------- */

describe("ExplorerActions relation-derived containment", () => {
  it("asks the canonical relation command to decide which documents a target affects", async () => {
    const harness = withTree(createHarness());
    harness.documents.sessions = [
      session(FILE_A, false, "doc-a"),
      session(`${SRC}\\nested\\b.ts`, false, "doc-b"),
    ];
    harness.explorer.selectPath(SRC);

    await harness.actions.delete();

    // Every open document with a disk path is checked against the target; the
    // target is the root of the question and no frontend prefix is compared.
    // The check runs for both the first confirmation and the post-dialog
    // re-check, which is what keeps the two rounds consistent.
    expect(harness.files.relationCalls).toEqual([
      { rootPath: SRC, targetPath: FILE_A },
      { rootPath: SRC, targetPath: `${SRC}\\nested\\b.ts` },
      { rootPath: SRC, targetPath: FILE_A },
      { rootPath: SRC, targetPath: `${SRC}\\nested\\b.ts` },
    ]);
    expect(harness.documents.removed).toEqual([["doc-a", "doc-b"]]);
  });

  it("does not treat a prefix sibling as being inside the target", async () => {
    const harness = withTree(createHarness());
    const sibling = "C:\\work\\src2\\c.ts";
    harness.documents.sessions = [
      session(FILE_A, false, "doc-inside"),
      session(sibling, false, "doc-sibling"),
    ];
    harness.explorer.selectPath(SRC);

    await harness.actions.delete();

    // `src2` merely shares a name prefix with `src`, so only the document that
    // really is inside is affected.
    expect(harness.documents.removed).toEqual([["doc-inside"]]);
  });

  it("never asks the relation command about an untitled document", async () => {
    const harness = withTree(createHarness());
    const untitled = session(`${SRC}\\b.ts`, true, "doc-untitled");
    harness.documents.sessions = [
      session(`${SRC}\\a.ts`, false, "doc-1"),
      { ...untitled, path: null, pathIdentity: null },
    ];
    harness.explorer.selectPath(SRC);

    await harness.actions.delete();

    // `unbound` documents are skipped locally and never reach the IPC boundary:
    // the only target ever asked about is the disk-backed session.
    expect(harness.files.relationCalls).toHaveLength(2);
    for (const call of harness.files.relationCalls) {
      expect(call.targetPath).toBe(`${SRC}\\a.ts`);
    }
    expect(harness.documents.removed).toEqual([["doc-1"]]);
  });

  it("finds the exact-target session for a file target without asking the relation command", async () => {
    const harness = withTree(createHarness());
    harness.documents.sessions = [
      session(FILE_A, true, "doc-target"),
      session("C:\\work\\other.ts", true, "doc-other"),
    ];
    harness.explorer.selectPath(FILE_A);

    await harness.actions.delete();

    // A file target is matched by its own canonical identity: the relation
    // command only accepts a directory root, so asking it about a file would
    // fail and silently lose the affected session.
    expect(harness.files.relationCalls).toEqual([]);
    // The unsaved-work warning is therefore still produced (FR-069)...
    expect(harness.dialogs.prompts[0]).toEqual({
      displayName: "a.ts",
      dirty: true,
      affectedDirtyNames: [],
    });
    // ...and the Tab is removed after the trash commits (FR-071), while an
    // unrelated open document is left alone.
    expect(harness.files.calls).toEqual([`trash:${FILE_A}`]);
    expect(harness.documents.removed).toEqual([["doc-target"]]);
  });

  it("never removes an unrelated session when a file target is deleted", async () => {
    const harness = withTree(createHarness());
    harness.documents.sessions = [session("C:\\work\\other.ts", false, "doc-other")];
    harness.explorer.selectPath(FILE_A);

    await harness.actions.delete();

    expect(harness.files.calls).toEqual([`trash:${FILE_A}`]);
    expect(harness.documents.removed).toEqual([[]]);
  });

  it("surfaces a relation failure and performs no destructive work", async () => {
    const harness = withTree(createHarness());
    harness.files.relationError = {
      code: "path_resolution",
      message: "Cannot resolve the target",
    };
    harness.documents.sessions = [session(FILE_A, false, "doc-a")];
    harness.explorer.selectPath(SRC);

    await harness.actions.delete();

    // An unanswerable containment question must abort the Delete rather than be
    // treated as "nothing is affected" (FR-069, FR-071).
    expect(harness.dialogs.errors).toEqual(["Cannot resolve the target"]);
    expect(harness.dialogs.prompts).toEqual([]);
    expect(harness.files.calls).toEqual([]);
    expect(harness.documents.removed).toEqual([]);
  });

  it("aborts a rename when the affected documents cannot be identified", async () => {
    const harness = withTree(createHarness());
    harness.files.relationError = {
      code: "path_resolution",
      message: "Cannot resolve the target",
    };
    harness.documents.sessions = [session(`${SRC}\\b.ts`, true, "doc-b")];
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: SRC,
      originalName: "src",
      draftName: "lib",
    };

    await harness.actions.commitInlineEdit();

    expect(harness.dialogs.errors).toEqual(["Cannot resolve the target"]);
    // No disk rename and no path commit happened.
    expect(harness.files.calls).toEqual([]);
    expect(harness.documents.renames).toEqual([]);
    expect(harness.documents.calls).toEqual([
      `reserve:${keyFor(SRC)}:${keyFor("C:\\work\\lib")}`,
      "release",
    ]);
  });

  it("reports an affected rename to the document commit by id", async () => {
    const harness = withTree(createHarness());
    harness.documents.sessions = [session(`${SRC}\\b.ts`, true, "doc-b")];
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: SRC,
      originalName: "src",
      draftName: "lib",
    };

    await harness.actions.commitInlineEdit();

    // The identified documents are handed to the commit, so containment is
    // decided in exactly one place.
    expect(harness.files.relationCalls).toEqual([
      { rootPath: SRC, targetPath: `${SRC}\\b.ts` },
    ]);
    expect(harness.documents.renames).toHaveLength(1);
    expect(harness.documents.renames[0].newPath).toBe("C:\\work\\lib");
    expect(harness.documents.renames[0].affectedDocumentIds).toEqual(["doc-b"]);
  });

  it("does not ask the relation command about a file target", async () => {
    const harness = withTree(createHarness());
    harness.documents.sessions = [session(FILE_A, false, "doc-a")];
    harness.explorer.selectPath(FILE_A);

    await harness.actions.delete();

    // A file root is rejected by the Rust command, so it is never asked about.
    expect(harness.files.relationCalls).toEqual([]);
    expect(harness.documents.removed).toEqual([["doc-a"]]);
  });
});

describe("ExplorerActions open (US3)", () => {
  it("routes an Explorer open through the document pipeline", async () => {
    const harness = withTree(createHarness());
    harness.documents.openResult = {
      status: "activated-existing",
      documentId: "doc-existing",
    };

    const result = await harness.actions.openFile(FILE_A);

    expect(result).toEqual({
      status: "activated-existing",
      documentId: "doc-existing",
    });
    expect(harness.documents.calls).toEqual([`open:${FILE_A}`]);
    // Opening a file never changes Explorer selection or expansion.
    expect(harness.explorer.calls).toEqual([]);
  });

  it("never opens a document for a single selection", () => {
    const harness = withTree(createHarness());
    const select = vi.spyOn(harness.explorer, "selectPath");

    harness.explorer.selectPath(FILE_A);

    expect(select).toHaveBeenCalledWith(FILE_A);
    expect(harness.documents.calls).toEqual([]);
  });
});

describe("pre-mutation source check under the directory's case contract (T154, T156)", () => {
  it("refuses a case-distinct same-identity sibling on a case-sensitive directory", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "renamed.ts",
    };

    // The backend reports a case-sensitive directory, so `A.TS` is a *different*
    // entry even though it resolves to the same filesystem object. Adopting it
    // would rename an entry the user never selected (Constitution I, FR-066).
    harness.files.setCaseSensitive(SRC);
    harness.files.setDirectoryListing(SRC, [movedEntry(FILE_A, `${SRC}\\A.TS`)]);
    const rename = vi.spyOn(harness.files, "renameWorkspaceEntry");

    expect(await harness.actions.commitInlineEdit()).toBe("retained");

    expect(rename).not.toHaveBeenCalled();
    expect(harness.documents.renames).toEqual([]);
    expect(harness.explorer.calls).toEqual([]);
    expect(harness.dialogs.errors).toEqual([SOURCE_ENTRY_CHANGED_MESSAGE]);
  });

  it("still renames an exactly spelled entry on a case-sensitive directory", async () => {
    const harness = withTree(createHarness());
    harness.explorer.inlineEdit = {
      type: "rename",
      sourcePath: FILE_A,
      originalName: "a.ts",
      draftName: "renamed.ts",
    };

    // The same object under the very spelling the user selected needs no folded
    // fallback at all, so a case-sensitive directory still works normally.
    harness.files.setCaseSensitive(SRC);

    expect(await harness.actions.commitInlineEdit()).toBe("committed");
    expect(harness.files.calls).toContain(`rename:${FILE_A}:renamed.ts`);
    expect(harness.dialogs.errors).toEqual([]);
  });
});
