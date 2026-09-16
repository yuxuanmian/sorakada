import { Text } from "@codemirror/state";

import type { EditorHandle } from "../../editor/editorHandle";
import type { FileDialogService } from "../../services/fileDialogs";
import type {
  FileCommandError,
  FileService,
  OpenTextFileResult,
  WriteTextFileRequest,
} from "../../services/fileService";
import { toFileCommandError } from "../../services/fileService";
import {
  createOpenedSession,
  createUntitledSession,
  displayNameForPath,
  type ActiveDocumentSession,
  type TextFormat,
} from "./documentSession";

/**
 * Outcome of a lifecycle command.
 *
 * `failed` carries the already-reported error so callers — notably the
 * unsaved-work guard — can decide whether a destructive action may continue.
 */
export type CommandResult =
  | { status: "success" }
  | { status: "cancelled" }
  | { status: "failed"; error: FileCommandError };

/** Receives every session transition, including derived dirty-state changes. */
export type SessionListener = (session: ActiveDocumentSession) => void;

export interface DocumentControllerDeps {
  /** The live editor; the only owner of the document text. */
  editor: EditorHandle;
  fileService: FileService;
  dialogs: FileDialogService;
  /**
   * Forced window destroy used by Exit. It bypasses close-request
   * interception, so an approved exit cannot recurse into the close handler.
   */
  destroyWindow: () => Promise<void>;
}

/**
 * Owns the single-document lifecycle: New/Open/Save/Save As/Exit, the saved
 * baseline, and the unsaved-work guard.
 *
 * Two invariants drive the whole class:
 *
 * 1. Only a successful disk write (or a successful open/New) may move the saved
 *    baseline. Everything else leaves the previous baseline intact.
 * 2. The baseline is the exact CodeMirror `Text` that was written, so editing
 *    while a save is in flight leaves the newer content dirty.
 */
export class DocumentController {
  private readonly editor: EditorHandle;
  private readonly fileService: FileService;
  private readonly dialogs: FileDialogService;
  private readonly destroyWindow: () => Promise<void>;
  private readonly listeners = new Set<SessionListener>();

  private session: ActiveDocumentSession = createUntitledSession();
  private savedBaseline: Text = Text.empty;

  /**
   * Bumped every time the active document is *replaced* (New / Open).
   *
   * A write captures this before it starts; a completion whose epoch no longer
   * matches belongs to a document that is no longer on screen and must not
   * touch the new document's baseline, path or dirty state.
   */
  private documentEpoch = 0;

  /**
   * Per-path write chains.
   *
   * Two overlapping writes to the same file must land in the order they were
   * issued, otherwise the earlier (staler) snapshot can win the race and the
   * file ends up with content the user already replaced.
   */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(deps: DocumentControllerDeps) {
    this.editor = deps.editor;
    this.fileService = deps.fileService;
    this.dialogs = deps.dialogs;
    this.destroyWindow = deps.destroyWindow;
  }

  /** The current session metadata. The live text lives in CodeMirror. */
  getSession(): ActiveDocumentSession {
    return this.session;
  }

  /** Subscribes to session transitions; returns the unsubscribe function. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Called by the editor on every CodeMirror `docChanged` report, which covers
   * typing, Undo and Redo alike.
   */
  handleDocumentChanged(): void {
    this.refreshDirty();
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle commands                                                     */
  /* ---------------------------------------------------------------------- */

  /** Replaces the document with a clean, pathless one. */
  async newDocument(): Promise<CommandResult> {
    if (!(await this.runUnsavedGuard())) {
      return { status: "cancelled" };
    }

    this.editor.setDocument("");
    this.documentEpoch += 1;
    this.savedBaseline = this.editor.getDocument();
    this.session = createUntitledSession();
    this.emit();

    return { status: "success" };
  }

  /**
   * Selects, reads and decodes a target file, then installs it.
   *
   * The target is validated *before* the unsaved guard runs, so a cancelled
   * picker or a read/decode failure never prompts and never disturbs the
   * current document.
   */
  async openDocument(): Promise<CommandResult> {
    const path = await this.dialogs.pickOpenPath();
    if (path === null) {
      return { status: "cancelled" };
    }

    let opened: OpenTextFileResult;
    try {
      opened = await this.fileService.readTextFile(path);
    } catch (error) {
      return { status: "failed", error: await this.reportError(error, "io_read") };
    }

    // Only now is the active document at risk of being discarded.
    if (!(await this.runUnsavedGuard())) {
      return { status: "cancelled" };
    }

    this.editor.setDocument(opened.text);
    this.documentEpoch += 1;
    this.savedBaseline = this.editor.getDocument();
    this.session = createOpenedSession(path, opened.format);
    this.emit();

    return { status: "success" };
  }

  /**
   * Saves to the current path, delegating to Save As for an untitled document.
   *
   * A clean same-path Save is a deliberate no-op: Sorakada does not retain
   * per-line EOL provenance, so rewriting an unedited Mixed file would
   * normalize bytes the user never touched.
   */
  async save(): Promise<CommandResult> {
    const { path, format, dirty } = this.session;

    if (path === null) {
      return this.saveAs();
    }
    if (!dirty) {
      return { status: "success" };
    }

    return this.writeSnapshot(path, format, false);
  }

  /** Writes the current document to a newly chosen destination. */
  async saveAs(): Promise<CommandResult> {
    const { path, format } = this.session;

    const target = await this.dialogs.pickSavePath(path);
    if (target === null) {
      return { status: "cancelled" };
    }

    return this.writeSnapshot(target, format, true);
  }

  /** Runs the unsaved guard and, when approved, force-destroys the window. */
  async exit(): Promise<CommandResult> {
    if (!(await this.runUnsavedGuard())) {
      return { status: "cancelled" };
    }

    await this.destroyWindow();
    return { status: "success" };
  }

  /**
   * The shared unsaved-work guard used by New, validated Open and Exit.
   *
   * Resolves `true` only when discarding the current document is allowed.
   */
  async runUnsavedGuard(): Promise<boolean> {
    if (!this.session.dirty) {
      return true;
    }

    const choice = await this.dialogs.confirmUnsavedChanges(
      this.session.displayName,
    );

    if (choice === "dontSave") {
      return true;
    }
    if (choice === "save") {
      const result = await this.save();
      return result.status === "success";
    }

    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Writes the *current* document exactly once, capturing the CodeMirror `Text`
   * that is being written before the asynchronous write starts.
   */
  private async writeSnapshot(
    path: string,
    format: TextFormat,
    adoptPath: boolean,
  ): Promise<CommandResult> {
    const snapshot = this.editor.getDocument();
    const epoch = this.documentEpoch;
    const request: WriteTextFileRequest = {
      path,
      // The exact logical document, serialized once, with LF separators.
      text: snapshot.toString(),
      bom: format.bom,
      lineEnding: format.preferredLineEnding,
    };

    try {
      await this.enqueueWrite(path, request);
    } catch (error) {
      return { status: "failed", error: await this.reportError(error, "io_write") };
    }

    if (this.documentEpoch !== epoch) {
      // The document was replaced (New/Open) while this write was in flight.
      // The bytes were still written — the user asked for that — but this
      // completion must not reach into the document that replaced it: its
      // baseline, path and dirty state already belong to something else.
      return { status: "success" };
    }

    // Success is the only event that may advance the path or the baseline.
    this.savedBaseline = snapshot;
    this.session = {
      ...this.session,
      ...(adoptPath ? { path, displayName: displayNameForPath(path) } : {}),
      // Compared against the *current* document: edits made while this write
      // was in flight must leave the document dirty.
      dirty: !this.editor.getDocument().eq(snapshot),
    };
    this.emit();

    return { status: "success" };
  }

  /**
   * Serialises writes per destination so they hit the disk in issue order.
   *
   * Without this, a slow first write could land after a later one and leave the
   * file holding a snapshot the user has already superseded.
   */
  private enqueueWrite(
    path: string,
    request: WriteTextFileRequest,
  ): Promise<void> {
    const previous = this.writeChains.get(path);
    // With nothing in flight for this path the write starts immediately; only
    // an overlapping write has to wait its turn.
    const write =
      previous === undefined
        ? this.fileService.writeTextFile(request)
        : previous
            .catch(() => undefined)
            .then(() => this.fileService.writeTextFile(request));

    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(path, settled);
    void settled.then(() => {
      if (this.writeChains.get(path) === settled) {
        this.writeChains.delete(path);
      }
    });

    return write;
  }

  /** Recomputes dirty from the live document against the saved baseline. */
  private refreshDirty(): void {
    if (!this.editor.isReady()) {
      return;
    }

    const dirty = !this.editor.getDocument().eq(this.savedBaseline);
    if (dirty !== this.session.dirty) {
      this.session = { ...this.session, dirty };
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.session);
    }
  }

  private async reportError(
    error: unknown,
    fallbackCode: "io_read" | "io_write",
  ): Promise<FileCommandError> {
    const fileError = toFileCommandError(error, fallbackCode);
    await this.dialogs.showError(fileError.message);
    return fileError;
  }
}
