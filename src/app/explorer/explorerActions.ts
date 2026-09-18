/**
 * Explorer operation contexts and filesystem orchestration.
 *
 * One derivation path decides what New File, New Folder, Rename and Delete
 * target, so the context menu, the Explorer header, keyboard actions and the
 * command registry cannot disagree about which entry an action applies to
 * (FR-075, FR-080).
 *
 * Every mutation is disk-first: the filesystem call has to succeed before any
 * document path or Explorer state is committed (FR-060, FR-064, FR-098), and
 * Rename/Delete reserve their paths through the document manager so overlapping
 * opens and saves cannot commit a stale path (FR-103).
 */

import { toFileCommandError, type FileCommandError } from "../../services/fileService";
import type { FileService } from "../../services/fileService";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceFileService,
} from "../../services/workspaceFileService";
import type { WorkspaceDialogService } from "../../services/workspaceDialogs";
import {
  displayNameForPath,
  type DocumentId,
} from "../document/documentSession";
import type {
  CommittedPathRename,
  OpenPathResult,
  PathMutationRequest,
  PathMutationResult,
} from "../document/documentManager";
import type { DocumentSession } from "../document/documentSession";
import type { WorkContextManager } from "../workspace/workContextManager";
import {
  isInsideRoot,
  joinPath,
  type WorkContext,
  type WorkContextId,
} from "../workspace/workContext";
import type { CreateEntryKind } from "./explorerController";
import type {
  ExplorerNode,
  ExplorerState,
  InlineEditState,
} from "./explorerModel";

/** The effective Workspace and Explorer target for a filesystem operation. */
export interface FileOperationContext {
  /** The active Workspace, or `null`. */
  workContext: WorkContext | null;
  /** The entry the operation applies to, or `null` for the root context. */
  selectedEntry: ExplorerNode | null;
  /** Directory a new entry is created in, or `null` when creation is invalid. */
  createParentPath: string | null;
  /** Entry Rename applies to, or `null` when Rename is invalid. */
  renameTargetPath: string | null;
  /** Entry Delete applies to, or `null` when Delete is invalid. */
  deleteTargetPath: string | null;
  /** Whether the operation context is the Workspace root rather than an entry. */
  isRootContext: boolean;
}

/** The Explorer context an asynchronous action began in. */
interface ExplorerOrigin {
  contextId: WorkContextId | null;
  generation: number;
}

/** The document-side surface the Explorer mutates through. */
export interface ExplorerDocumentPort {
  openPath(path: string): Promise<OpenPathResult>;
  /**
   * Every open session whose current path is `key` itself or below it.
   *
   * This is the canonical candidate set for an operation targeting `key`; it is
   * what makes a file target's own session part of the answer.
   */
  findSessionsUnder(key: string): readonly DocumentSession[];
  reservePathMutation(request: PathMutationRequest): Promise<PathMutationResult>;
  commitRenamedPath(request: CommittedPathRename): readonly DocumentId[];
  removeDeletedSessions(ids: readonly DocumentId[]): readonly DocumentId[];
}

/**
 * The Explorer surface the actions drive.
 *
 * It is a structural interface rather than the concrete controller so the
 * orchestration rules — what gets reserved, what may be committed, and in which
 * order — can be tested without a rendered tree.
 */
export interface ExplorerActionTarget {
  /** The current projection, including the stale-result generation token. */
  getState(): ExplorerState;
  /** The selected node, or `null`. */
  getSelectedNode(): ExplorerNode | null;
  /** Any visible node by path, or `null`. */
  getNode(path: string): ExplorerNode | null;
  /** The active inline editor, if any. */
  getInlineEdit(): InlineEditState | null;
  /** Sets the persistent operation-context selection. */
  selectPath(path: string | null): void;
  /** Clears the selection (blank-space context). */
  clearSelection(): void;
  /** Expands (and loads) a directory. */
  expandDirectory(path: string): Promise<void>;
  /** Starts the inline New File/New Folder editor under `parentPath`. */
  beginCreate(kind: CreateEntryKind, parentPath: string): void;
  /** Starts the inline Rename editor for `sourcePath`. */
  beginRename(sourcePath: string): void;
  /** Discards the inline editor. */
  cancelInlineEdit(): void;
  /** Inserts a successfully created entry into its parent's children. */
  applyCreatedEntry(parentPath: string, entry: WorkspaceDirectoryEntry): void;
  /** Applies a successful rename to the visible tree. */
  applyRenamedEntry(request: {
    sourcePath: string;
    newPath: string;
    newName: string;
  }): void;
  /** Applies a successful delete to the visible tree. */
  applyDeletedEntry(path: string): void;
  /** Rereads every already-loaded directory. */
  refresh(): Promise<void>;
  /**
   * Clears the root-unavailable state after the root was proven readable.
   */
  markRootAvailable(): void;
}

export interface ExplorerActionDeps {
  explorer: ExplorerActionTarget;
  workContexts: Pick<WorkContextManager, "getContext">;
  workspaceFileService: WorkspaceFileService;
  documents: ExplorerDocumentPort;
  dialogs: WorkspaceDialogService;
  /** Reuses the 002 identity primitive to key paths for coordination. */
  fileService: Pick<FileService, "inspectFilePath">;
}

/**
 * The parent directory path of a visible entry.
 *
 * The Explorer builds entry paths by joining a directory path with an entry
 * name, so removing the last component is exact here — no filesystem call is
 * needed just to answer "which directory would a new file go in?".
 */
export function parentPathOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) {
    return trimmed;
  }

  const parent = trimmed.slice(0, index);
  // A drive root keeps its separator, because `C:` alone is a drive-relative
  // reference rather than the root directory.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/**
 * Derives the operation context from the active Workspace and the selection.
 *
 * The rules are the frozen target table from `data-model.md`: a selected
 * directory targets itself, a selected file targets its parent for creation and
 * itself for Rename/Delete, and the root context can only create and refresh.
 */
export function deriveFileOperationContext(
  workContext: WorkContext | null,
  selectedEntry: ExplorerNode | null,
): FileOperationContext {
  if (workContext === null) {
    return {
      workContext: null,
      selectedEntry: null,
      createParentPath: null,
      renameTargetPath: null,
      deleteTargetPath: null,
      isRootContext: false,
    };
  }

  const isRoot = selectedEntry !== null && selectedEntry.path === workContext.rootPath;
  const isRootContext = selectedEntry === null || isRoot;

  const createParentPath = isRootContext
    ? workContext.rootPath
    : selectedEntry.kind === "directory"
      ? selectedEntry.path
      : parentPathOf(selectedEntry.path);

  return {
    workContext,
    selectedEntry,
    createParentPath,
    renameTargetPath: isRootContext ? null : selectedEntry.path,
    deleteTargetPath: isRootContext ? null : selectedEntry.path,
    isRootContext,
  };
}

/** Whether Explorer creation can run for this context (FR-049, FR-053). */
export function isCreateAvailable(context: FileOperationContext): boolean {
  return context.workContext !== null && context.createParentPath !== null;
}

/** Whether Rename can run for this context: a selected non-root entry (FR-058). */
export function isRenameAvailable(context: FileOperationContext): boolean {
  return context.renameTargetPath !== null;
}

/** Whether Delete can run for this context: a selected non-root entry (FR-065). */
export function isDeleteAvailable(context: FileOperationContext): boolean {
  return context.deleteTargetPath !== null;
}

/** Whether Refresh can run: any active Workspace (FR-082). */
export function isRefreshAvailable(context: FileOperationContext): boolean {
  return context.workContext !== null;
}

/**
 * Whether the Explorer *context menu* may offer Refresh (plan decision 12).
 *
 * A file context offers New File, New Folder, Rename and Delete only. Refresh
 * stays on the root and directory contexts — and on the Explorer header, which
 * calls the same loaded-tree operation whatever is selected — so the operation
 * itself keeps one implementation (FR-080, FR-082).
 */
export function isContextMenuRefreshAvailable(
  context: FileOperationContext,
): boolean {
  if (!isRefreshAvailable(context)) {
    return false;
  }

  const entry = context.selectedEntry;
  return entry === null || entry.kind === "directory";
}

/** What one Delete confirmation describes. */
interface DeleteConfirmation {
  request: {
    displayName: string;
    dirty: boolean;
    affectedDirtyNames: readonly string[];
  };
  /** Every currently dirty display name involved, for the re-check. */
  dirtyNames: Set<string>;
  /** The sessions the target contains, as derived at confirmation time. */
  affected: readonly DocumentSession[];
}

/**
 * The outcome of identifying the sessions a target contains.
 *
 * A failure is distinguishable from "nothing is affected", because the two lead
 * to opposite decisions: the first must abort the operation, the second is a
 * normal Delete of an unopened entry.
 */
type AffectedSessionsResult =
  | { status: "ok"; sessions: readonly DocumentSession[] }
  | { status: "failed"; error: FileCommandError };

/** A prepared Delete confirmation, or the reason it could not be prepared. */
type DescribeDeleteResult =
  | { status: "ok"; confirmation: DeleteConfirmation }
  | { status: "failed"; error: FileCommandError };

/**
 * Reserves, mutates and reconciles Explorer filesystem operations.
 */
export class ExplorerActions {
  private readonly deps: ExplorerActionDeps;

  constructor(deps: ExplorerActionDeps) {
    this.deps = deps;
  }

  /* ---------------------------------------------------------------------- */
  /* Operation context                                                      */
  /* ---------------------------------------------------------------------- */

  /** The operation context for `node`, or for the current selection. */
  contextFor(node?: ExplorerNode | null): FileOperationContext {
    const selected =
      node === undefined ? this.deps.explorer.getSelectedNode() : node;
    return deriveFileOperationContext(
      this.deps.workContexts.getContext(),
      selected,
    );
  }

  /**
   * Applies right-click selection semantics and returns the menu's context.
   *
   * Right-clicking a node selects it *first*, so every action derived from the
   * menu targets the entry the user pointed at; right-clicking blank space
   * clears the concrete selection and falls back to the Workspace root context
   * so a stale node target can never be reused (FR-076, FR-077).
   */
  handleContextMenu(node: ExplorerNode | null): FileOperationContext {
    if (node === null) {
      this.deps.explorer.clearSelection();
      return this.contextFor(null);
    }

    this.deps.explorer.selectPath(node.path);
    return this.contextFor(node);
  }

  isCreateAvailable(): boolean {
    return isCreateAvailable(this.contextFor());
  }

  isRenameAvailable(): boolean {
    return isRenameAvailable(this.contextFor());
  }

  isDeleteAvailable(): boolean {
    return isDeleteAvailable(this.contextFor());
  }

  isRefreshAvailable(): boolean {
    return isRefreshAvailable(this.contextFor());
  }

  /** Whether the context menu should offer Refresh for the current target. */
  isContextMenuRefreshAvailable(): boolean {
    return isContextMenuRefreshAvailable(this.contextFor());
  }

  /* ---------------------------------------------------------------------- */
  /* Opening                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Opens a file through the shared document pipeline.
   *
   * Explorer double-click has no separate open implementation, so duplicate
   * detection and identity rules cannot diverge from File > Open or drag/drop
   * (FR-036, FR-044).
   */
  async openFile(path: string): Promise<OpenPathResult> {
    return this.deps.documents.openPath(path);
  }

  /* ---------------------------------------------------------------------- */
  /* Create                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Starts the inline New File editor at the derived parent. */
  async newFile(): Promise<void> {
    await this.beginCreate("file");
  }

  /** Starts the inline New Folder editor at the derived parent. */
  async newFolder(): Promise<void> {
    await this.beginCreate("directory");
  }

  private async beginCreate(kind: CreateEntryKind): Promise<void> {
    const context = this.contextFor();
    const parentPath = context.createParentPath;
    if (!isCreateAvailable(context) || parentPath === null) {
      return;
    }

    // The editor is rendered inside the target directory's child list, so that
    // directory has to be expanded (and read) for the user to see it.
    //
    // That read is awaited, and replacing the Workspace during it rebuilds the
    // Tree, so the editor may only be opened in the context that asked for it
    // (FR-030, FR-089).
    const origin = this.captureOrigin();
    await this.deps.explorer.expandDirectory(parentPath);
    if (!this.isCurrentOrigin(origin)) {
      return;
    }

    this.deps.explorer.selectPath(parentPath);
    this.deps.explorer.beginCreate(kind, parentPath);
  }

  /* ---------------------------------------------------------------------- */
  /* Inline commit                                                          */
  /* ---------------------------------------------------------------------- */

  /** Commits the active inline create or rename editor. */
  async commitInlineEdit(): Promise<void> {
    const edit = this.deps.explorer.getInlineEdit();
    if (edit === null) {
      return;
    }

    if (edit.type === "rename") {
      await this.commitRename(edit.sourcePath, edit.originalName, edit.draftName);
      return;
    }

    await this.commitCreate(
      edit.type === "create-file" ? "file" : "directory",
      edit.parentPath,
      edit.draftName,
    );
  }

  private async commitCreate(
    kind: CreateEntryKind,
    parentPath: string,
    draftName: string,
  ): Promise<void> {
    const name = draftName.trim();
    if (name === "") {
      // Nothing was named, so nothing may be created. The editor stays open so
      // the user can either type a name or cancel explicitly (FR-054).
      return;
    }

    // Everything below is awaited, so the Workspace can be replaced before the
    // entry exists; the Tree reconciliation has to stay with the context that
    // started the creation (FR-030, FR-089).
    const origin = this.captureOrigin();

    // Creation is a path transition like any other: the destination is resolved
    // and reserved before anything is written, so an overlapping Save As or Open
    // cannot claim the same canonical path while the entry is being created
    // (FR-100, plan decision 15).
    const destinationPath = joinPath(parentPath, name);
    let destinationIdentity;
    try {
      destinationIdentity = await this.deps.fileService.inspectFilePath(
        destinationPath,
        true,
      );
    } catch (error) {
      await this.reportError(error, "path_resolution");
      return;
    }

    const reservation = await this.deps.documents.reservePathMutation({
      sourceKey: destinationIdentity.comparisonKey,
    });
    if (reservation.status === "failed") {
      await this.deps.dialogs.showError(reservation.error.message);
      return;
    }

    let created;
    try {
      created = await this.deps.workspaceFileService.createWorkspaceEntry({
        parentPath,
        name,
        kind,
      });
    } catch (error) {
      // The failure is reported and the draft is kept: no Tree node may appear
      // for an entry that does not exist (FR-057).
      await this.reportError(error, "io_create");
      return;
    } finally {
      // The claim is given back as soon as the create attempt is over, on both
      // outcomes. It is not held through the Open below, because that Open
      // targets the destination this very reservation covers: as the
      // reservation's owner the actions must not wait on themselves. The Open is
      // issued in the same turn, so a competing operation can only converge on
      // the one created destination rather than duplicate it.
      reservation.reservation.release();
    }

    const entry: WorkspaceDirectoryEntry = {
      name,
      path: created.path,
      kind,
      isSymlink: false,
    };

    // The Tree is only told about the new entry while it still shows the context
    // the creation started in. The document below is Workspace-independent, so
    // it opens either way (FR-010, FR-030).
    if (this.isCurrentOrigin(origin)) {
      this.deps.explorer.cancelInlineEdit();
      this.deps.explorer.applyCreatedEntry(parentPath, entry);
      this.deps.explorer.selectPath(created.path);
    }

    if (kind === "file") {
      // FR-055: a new file is selected *and* opened through the ordinary open
      // pipeline; a new folder is selected only (FR-056).
      await this.deps.documents.openPath(created.path);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Rename                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Starts the inline Rename editor for the selected non-root entry. */
  rename(): void {
    const context = this.contextFor();
    if (context.renameTargetPath === null) {
      return;
    }

    this.deps.explorer.beginRename(context.renameTargetPath);
  }

  /**
   * Renames on disk first and commits paths only after success.
   *
   * Order matters: resolve identities, reserve the destination against other
   * document operations, rename on disk, then update document paths and the
   * Tree. Anything that fails before the disk operation leaves every piece of
   * state exactly as it was (FR-060, FR-063, FR-064).
   */
  private async commitRename(
    sourcePath: string,
    originalName: string,
    draftName: string,
  ): Promise<void> {
    const newName = draftName.trim();
    if (newName === "" || newName === originalName) {
      // An unchanged name is not a rename; cancelling keeps the filesystem and
      // the document paths untouched.
      this.deps.explorer.cancelInlineEdit();
      return;
    }

    // The Workspace can be replaced while any of the awaits below is in flight,
    // so the context this rename belongs to is captured before the first one
    // (FR-030, FR-089).
    const origin = this.captureOrigin();

    const destinationPath = joinPath(parentPathOf(sourcePath), newName);

    let sourceIdentity;
    let destinationIdentity;
    try {
      sourceIdentity = await this.deps.fileService.inspectFilePath(
        sourcePath,
        false,
      );
      destinationIdentity = await this.deps.fileService.inspectFilePath(
        destinationPath,
        true,
      );
    } catch (error) {
      await this.reportError(error, "path_resolution");
      return;
    }

    const reservation = await this.deps.documents.reservePathMutation({
      sourceKey: sourceIdentity.comparisonKey,
      destinationKey: destinationIdentity.comparisonKey,
    });
    if (reservation.status === "failed") {
      await this.deps.dialogs.showError(reservation.error.message);
      return;
    }

    // Identified before the disk operation and under the reservation, so the
    // sessions whose paths must be rebased are decided from their *current*
    // canonical paths rather than from a path string comparison (FR-062).
    const identified = await this.affectedSessions(
      sourcePath,
      sourceIdentity.comparisonKey,
      sourceIdentity.kind === "directory",
    );
    if (identified.status === "failed") {
      // Without a trustworthy affected set the path commit would silently skip
      // documents that the disk rename just moved (FR-062, FR-103).
      await this.deps.dialogs.showError(identified.error.message);
      reservation.reservation.release();
      return;
    }
    const affectedIds = identified.sessions.map((session) => session.id);

    try {
      const renamed = await this.deps.workspaceFileService.renameWorkspaceEntry({
        sourcePath,
        newName,
      });

      // Disk succeeded: document paths follow the disk immediately, because the
      // file is already at its new location.
      this.deps.documents.commitRenamedPath({
        sourceIdentity: {
          canonicalPath: sourceIdentity.canonicalPath,
          comparisonKey: sourceIdentity.comparisonKey,
        },
        newPath: renamed.newPath,
        newIdentity: renamed.newIdentity,
        affectedDocumentIds: affectedIds,
      });

      // The document paths above follow the disk unconditionally, because the
      // file really moved. The Tree, the selection and the inline editor belong
      // to one Workspace context, so they are only touched while that context is
      // still the current one (FR-030, FR-089).
      if (this.isCurrentOrigin(origin)) {
        this.deps.explorer.applyRenamedEntry({
          sourcePath,
          newPath: renamed.newPath,
          newName,
        });
        this.deps.explorer.cancelInlineEdit();
        this.deps.explorer.selectPath(renamed.newPath);
      }
    } catch (error) {
      // FR-064: the disk rename failed, so neither document paths nor Tree
      // state may change — and the draft stays for correction.
      await this.reportError(error, "io_rename");
    } finally {
      reservation.reservation.release();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Delete                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Confirms and performs Delete for the selected non-root entry. */
  async delete(): Promise<void> {
    const context = this.contextFor();
    const targetPath = context.deleteTargetPath;
    if (targetPath === null) {
      return;
    }

    let targetIdentity;
    try {
      targetIdentity = await this.deps.fileService.inspectFilePath(
        targetPath,
        false,
      );
    } catch (error) {
      await this.reportError(error, "path_resolution");
      return;
    }

    const targetKey = targetIdentity.comparisonKey;
    const targetIsDirectory = targetIdentity.kind === "directory";

    // Reserving first settles pending saves/opens under the target before the
    // user is even asked, and stops a new Open from registering the old path
    // while the trash operation is in flight (FR-103).
    const reservation = await this.deps.documents.reservePathMutation({
      sourceKey: targetKey,
    });
    if (reservation.status === "failed") {
      await this.deps.dialogs.showError(reservation.error.message);
      return;
    }

    const generation = this.deps.explorer.getState().generation;

    try {
      const first = await this.describeDelete(
        targetPath,
        targetKey,
        targetIsDirectory,
      );
      if (first.status === "failed") {
        // The affected set could not be established, so the destructive
        // operation must not run on the assumption that nothing is open.
        await this.deps.dialogs.showError(first.error.message);
        return;
      }
      if (!(await this.deps.dialogs.confirmDelete(first.confirmation.request))) {
        return; // FR-070: a cancelled Delete changes nothing.
      }

      // The dialog is asynchronous, so the target's dirty state is re-checked
      // afterwards; work that became unsaved while the user was deciding must
      // be warned about again rather than silently discarded (FR-069).
      const second = await this.describeDelete(
        targetPath,
        targetKey,
        targetIsDirectory,
      );
      if (second.status === "failed") {
        await this.deps.dialogs.showError(second.error.message);
        return;
      }

      const escalated = [...second.confirmation.dirtyNames].filter(
        (name) => !first.confirmation.dirtyNames.has(name),
      );
      if (
        escalated.length > 0 &&
        !(await this.deps.dialogs.confirmDelete(second.confirmation.request))
      ) {
        return;
      }

      // Trash first: only a successful OS trash operation may remove sessions,
      // and a failure leaves both Tabs and nodes exactly as they were
      // (FR-066, FR-071, FR-073).
      await this.deps.workspaceFileService.trashWorkspaceEntry(targetPath);

      this.deps.documents.removeDeletedSessions(
        second.confirmation.affected.map((session) => session.id),
      );

      if (this.deps.explorer.getState().generation === generation) {
        this.deps.explorer.applyDeletedEntry(targetPath);
      }
    } catch (error) {
      await this.reportError(error, "io_trash");
    } finally {
      reservation.reservation.release();
    }
  }

  /**
   * Describes one Delete confirmation from the sessions actually affected.
   *
   * Affected sessions come from `affectedSessions`, so a directory Delete never
   * scans the directory on disk and never relies on a frontend path comparison,
   * and a file Delete still finds the session that owns the file itself
   * (FR-043, FR-069, FR-071, FR-072).
   */
  private async describeDelete(
    targetPath: string,
    targetKey: string,
    targetIsDirectory: boolean,
  ): Promise<DescribeDeleteResult> {
    const identified = await this.affectedSessions(
      targetPath,
      targetKey,
      targetIsDirectory,
    );
    if (identified.status === "failed") {
      return { status: "failed", error: identified.error };
    }

    const affected = identified.sessions;
    const innerDirty: string[] = [];
    const dirtyNames = new Set<string>();
    let targetDirty = false;

    for (const session of affected) {
      if (!session.dirty) {
        continue;
      }
      dirtyNames.add(session.displayName);
      if (session.pathIdentity?.comparisonKey === targetKey) {
        targetDirty = true;
      } else {
        innerDirty.push(session.displayName);
      }
    }

    return {
      status: "ok",
      confirmation: {
        request: {
          displayName: displayNameForPath(targetPath),
          dirty: targetDirty,
          affectedDirtyNames: innerDirty,
        },
        dirtyNames,
        affected,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Refresh                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Rereads every already-loaded directory.
   *
   * The Explorer header, the root context menu and a directory's context menu
   * all call this one operation, so no surface triggers a separate subtree scan
   * (FR-082).
   */
  async refresh(): Promise<void> {
    await this.deps.explorer.refresh();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The Explorer context this action began in.
   *
   * `contextId` identifies the Workspace's Tree state and `generation` changes
   * whenever that state is rebuilt, so together they tell an awaited completion
   * whether the Explorer it is about to mutate is still the one it started in.
   */
  private captureOrigin(): ExplorerOrigin {
    const state = this.deps.explorer.getState();
    return { contextId: state.contextId, generation: state.generation };
  }

  /** Whether the Explorer still shows the context `origin` was captured in. */
  private isCurrentOrigin(origin: ExplorerOrigin): boolean {
    const state = this.deps.explorer.getState();
    return (
      state.contextId === origin.contextId &&
      state.generation === origin.generation
    );
  }

  /**
   * The open documents an operation at `targetPath` actually affects.
   *
   * Containment for documents *below* the target is answered by the canonical
   * `resolve_workspace_relation` primitive with the target directory as the root,
   * which is the reuse plan decision 5 requires: no frontend path comparison
   * decides whether a document is inside a directory, so a sibling whose name
   * merely starts with the target's name can never be dragged into a Rename or
   * Delete. The candidate set comes from the document manager's canonical
   * at-or-below lookup, which is also what makes the target's own session part of
   * the answer.
   *
   * Two cases are deliberately decided without that command:
   *
   * - a session whose canonical identity *is* the target is the target, and the
   *   command only accepts a directory root, so a file target could never be
   *   resolved through containment;
   * - a file target contains nothing else, so there is nothing below it to ask
   *   about.
   *
   * A document with no disk path is `unbound` and is never affected. A
   * resolution failure is reported instead of being treated as `outside`: the
   * caller must never trash a file while silently believing that no open
   * document is involved (FR-069, FR-071).
   */
  private async affectedSessions(
    targetPath: string,
    targetKey: string,
    targetIsDirectory: boolean,
  ): Promise<AffectedSessionsResult> {
    // The document manager's canonical at-or-below lookup supplies the candidate
    // set. It already includes the exact target — a file target's own session —
    // and it can never return an Untitled document, because those have no disk
    // path at all.
    const candidates = this.deps.documents.findSessionsUnder(targetKey);
    const affected: DocumentSession[] = [];

    for (const session of candidates) {
      const identity = session.pathIdentity;
      if (session.path === null || identity === null) {
        continue;
      }

      if (identity.comparisonKey === targetKey) {
        affected.push(session);
        continue;
      }

      if (!targetIsDirectory) {
        continue;
      }

      try {
        if (
          await isInsideRoot(
            this.deps.workspaceFileService,
            targetPath,
            session.path,
          )
        ) {
          affected.push(session);
        }
      } catch (error) {
        return {
          status: "failed",
          error: toFileCommandError(error, "path_resolution"),
        };
      }
    }

    return { status: "ok", sessions: affected };
  }

  /** Normalizes and reports a failure the user needs to see. */
  private async reportError(
    error: unknown,
    fallbackCode: FileCommandError["code"],
  ): Promise<void> {
    const fileError = toFileCommandError(error, fallbackCode);
    await this.deps.dialogs.showError(fileError.message);
  }
}
