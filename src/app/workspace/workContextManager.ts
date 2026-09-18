/**
 * Owner of the one active Workspace identity.
 *
 * `WorkContextManager` holds *only* the Workspace root: documents, Explorer tree
 * state and filesystem operations all live elsewhere. That separation is what
 * makes "open a Workspace" and "close a Workspace" independent from the document
 * lifecycle (FR-003, FR-008) and what lets the Explorer be discarded and rebuilt
 * without touching an editor.
 *
 * Opening is atomic: a candidate root must be readable before it may replace the
 * active context, and every request carries an intent token so an older
 * completion can never replace a newer Workspace (FR-006, FR-007).
 */

import {
  toFileCommandError,
  type FileCommandError,
} from "../../services/fileService";
import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceFileService,
} from "../../services/workspaceFileService";
import type { WorkspaceDialogService } from "../../services/workspaceDialogs";
import {
  createWorkContextId,
  displayNameForWorkspaceRoot,
  type WorkContext,
} from "./workContext";

/** What the application renders about the active Workspace. */
export interface WorkContextSnapshot {
  /** The active Workspace, or `null` when none is open. */
  context: WorkContext | null;
  /**
   * Increases on every committed replacement or close.
   *
   * It is the token that lets asynchronous Explorer work detect that its result
   * belongs to a Workspace the user already left.
   */
  generation: number;
  /**
   * Whether the active root could not be read on the last access.
   *
   * The context is still active; the Explorer shows an error state and Refresh
   * retries (FR-088).
   */
  rootUnavailable: boolean;
}

/** Outcome of an Open Folder request. */
export type OpenWorkContextResult =
  | { status: "opened"; context: WorkContext }
  | { status: "unchanged"; context: WorkContext }
  | { status: "superseded" }
  | { status: "cancelled" }
  | { status: "failed"; error: FileCommandError };

export type WorkContextListener = (snapshot: WorkContextSnapshot) => void;

export interface WorkContextManagerDeps {
  /** Only the directory read is needed to prepare a candidate root. */
  workspaceFileService: Pick<WorkspaceFileService, "readWorkspaceDirectory">;
  /** Folder picker plus failure reporting. */
  dialogs: Pick<WorkspaceDialogService, "pickWorkspaceFolder" | "showError">;
}

export class WorkContextManager {
  private readonly deps: WorkContextManagerDeps;
  private readonly listeners = new Set<WorkContextListener>();

  private context: WorkContext | null = null;
  private generation = 0;
  private rootUnavailable = false;

  /**
   * The newest request the user expressed.
   *
   * Every open/close bumps it, so a completion can tell whether it is still the
   * latest intent (FR-007).
   */
  private intent = 0;

  constructor(deps: WorkContextManagerDeps) {
    this.deps = deps;
  }

  /* ---------------------------------------------------------------------- */
  /* Read surface                                                           */
  /* ---------------------------------------------------------------------- */

  /** The active Workspace, or `null`. */
  getContext(): WorkContext | null {
    return this.context;
  }

  /** The committed generation token. */
  getGeneration(): number {
    return this.generation;
  }

  /** Whether the active root failed its last read. */
  isRootUnavailable(): boolean {
    return this.rootUnavailable;
  }

  /** The current projection. */
  getSnapshot(): WorkContextSnapshot {
    return {
      context: this.context,
      generation: this.generation,
      rootUnavailable: this.rootUnavailable,
    };
  }

  /** Subscribes to Workspace changes; returns the unsubscribe function. */
  subscribe(listener: WorkContextListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Opening and closing                                                    */
  /* ---------------------------------------------------------------------- */

  /** Asks for a folder and opens it as the Workspace. */
  async openFromDialog(): Promise<OpenWorkContextResult> {
    // The intent token is taken *before* the native picker is awaited. The
    // picker is asynchronous and the user's intent is expressed when the request
    // starts, so an earlier dialog that happens to return after a newer
    // Workspace was committed must not replace it (FR-007).
    const intent = this.beginIntent();

    const path = await this.deps.dialogs.pickWorkspaceFolder();
    if (path === null) {
      return { status: "cancelled" };
    }

    return this.openFolderWithIntent(intent, path);
  }

  /**
   * Opens `rootPath` as the active Workspace.
   *
   * The candidate is resolved and read *before* anything is replaced, so a
   * failure leaves the previous Workspace exactly as it was. Reopening the same
   * canonical root is a no-op rather than a rebuild, and an older completion
   * loses to a newer request.
   */
  async openFolder(rootPath: string): Promise<OpenWorkContextResult> {
    return this.openFolderWithIntent(this.beginIntent(), rootPath);
  }

  /** Prepares and commits one candidate under an already-issued intent token. */
  private async openFolderWithIntent(
    intent: number,
    rootPath: string,
  ): Promise<OpenWorkContextResult> {
    let read: ReadWorkspaceDirectoryResult;
    try {
      read = await this.deps.workspaceFileService.readWorkspaceDirectory(rootPath);
    } catch (error) {
      if (intent !== this.intent) {
        return { status: "superseded" };
      }
      const fileError = toFileCommandError(error, "io_directory");
      await this.deps.dialogs.showError(fileError.message);
      return { status: "failed", error: fileError };
    }

    if (intent !== this.intent) {
      // A newer request is already deciding; this candidate must change nothing.
      return { status: "superseded" };
    }

    const active = this.context;
    if (active !== null && active.comparisonKey === read.comparisonKey) {
      // The same canonical root, whatever spelling was used. The Explorer keeps
      // its current transient state instead of being rebuilt (FR-005).
      if (this.rootUnavailable) {
        this.rootUnavailable = false;
        this.emit();
      }
      return { status: "unchanged", context: active };
    }

    const context: WorkContext = {
      id: createWorkContextId(),
      rootPath: read.requestedPath,
      canonicalRootPath: read.canonicalPath,
      comparisonKey: read.comparisonKey,
      displayName: displayNameForWorkspaceRoot(read.requestedPath),
    };

    // Only now, with a readable root, may the previous context be replaced.
    this.context = context;
    this.rootUnavailable = false;
    this.generation += 1;
    this.emit();

    return { status: "opened", context };
  }

  /** Closes the active Workspace. Documents are never touched. */
  close(): void {
    // An in-flight open is now stale: a late candidate must not reopen a
    // Workspace the user just closed.
    this.intent += 1;

    if (this.context === null) {
      return;
    }

    this.context = null;
    this.rootUnavailable = false;
    this.generation += 1;
    this.emit();
  }

  /**
   * Records whether the active root is currently readable.
   *
   * Losing access to the root does not close the Workspace: the context stays
   * active, the Explorer shows an unavailable/error state, and a later Refresh
   * clears the flag by reading the root again (FR-088).
   */
  setRootUnavailable(unavailable: boolean): void {
    if (this.context === null || this.rootUnavailable === unavailable) {
      return;
    }

    this.rootUnavailable = unavailable;
    this.emit();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private beginIntent(): number {
    this.intent += 1;
    return this.intent;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
