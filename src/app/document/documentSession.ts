/**
 * Session metadata for the documents hosted by CodeMirror.
 *
 * The live text itself deliberately does not live here: CodeMirror owns it. This
 * module describes *which* documents are open, *where* each one came from, *how*
 * it must be written back, and whether it currently differs from its last saved
 * snapshot.
 */

import type { EditorState, Text } from "@codemirror/state";

import type {
  DiskRevision,
  ResolvedPathIdentity,
} from "../../services/fileService";

/** M1 supports UTF-8 only; the field stays enum-shaped for later expansion. */
export type Encoding = "utf8";

/** Whether a UTF-8 BOM must be emitted when the document is written. */
export type Bom = "none" | "utf8";

/** The line endings actually observed when the document was opened or created. */
export type DetectedLineEnding = "none" | "lf" | "crlf" | "mixed";

/** A concrete physical line ending. `mixed`/`none` are never written. */
export type LineEnding = "lf" | "crlf";

/** Disk-oriented format metadata retained separately from the normalized text. */
export interface TextFormat {
  encoding: Encoding;
  bom: Bom;
  detectedLineEnding: DetectedLineEnding;
  preferredLineEnding: LineEnding;
}

/**
 * A stable opaque identifier assigned when a document session is created.
 *
 * It is never derived from the display name or the file path, and it does not
 * change when the document is renamed through Save As. Asynchronous operations
 * capture this id and use it to find their originating session on completion.
 */
export type DocumentId = string;

/** Reading position that `EditorState` does not preserve on its own. */
export interface DocumentViewState {
  /** Vertical scroll offset of the shared view when this document left it. */
  scrollTop: number;
  /** Horizontal scroll offset of the shared view when this document left it. */
  scrollLeft: number;
}

/**
 * How the bound disk file relates to the last baseline Sorakada adopted (005).
 *
 * This is deliberately orthogonal to `dirty` (FR-008, FR-009): `dirty` describes
 * the in-memory document versus its saved baseline, while this describes the
 * file on disk versus that same baseline. A document can therefore be
 * clean+missing or dirty+modified, which a single conflict flag could not
 * express. Watcher events never set it directly — only a validation result may.
 */
export type ExternalState = "normal" | "modified" | "missing";

/** One open document. */
export interface DocumentSession {
  /** Stable identity; unchanged by Save As. */
  id: DocumentId;
  /** Current disk destination; `null` while the document is untitled. */
  path: string | null;
  /** Internal comparison/revision metadata; `null` while untitled. */
  pathIdentity: ResolvedPathIdentity | null;
  /** `UntitledN` or the basename derived from `path`. */
  displayName: string;
  /** Format used when this document has to be written to disk. */
  format: TextFormat;
  /** Derived from the live CodeMirror document versus the saved baseline. */
  dirty: boolean;
  /** The exact `Text` represented by the latest relevant successful save. */
  savedBaseline: Text;
  /** The newest CodeMirror state reported for this document. */
  editorState: EditorState;
  /** Scroll/read position captured when this document left the shared view. */
  viewState: DocumentViewState;
  /**
   * Incremented for every explicit save intent, so a completion that is no
   * longer the newest intent cannot adopt a path or advance the baseline.
   */
  latestSaveGeneration: number;
  /**
   * How the bound file currently relates to the adopted baseline (005).
   *
   * Only `DocumentManager` transitions may change it, and always from a
   * validation result for a still-current binding.
   */
  externalState: ExternalState;
  /**
   * Incremented whenever the bound path changes (005).
   *
   * Asynchronous validation and reload completions capture this value and are
   * discarded when the document has since been rebound by Save As or an internal
   * Explorer Rename, or was closed and reopened under the same id (FR-039).
   */
  bindingGeneration: number;
}

/** Lightweight projection of one Tab. Contains no document text. */
export interface TabSnapshot {
  id: DocumentId;
  displayName: string;
  path: string | null;
  dirty: boolean;
  active: boolean;
  /**
   * The document's external disk state (005).
   *
   * Tab-visible, because FR-041 requires `modified`/`missing` to be visible
   * without a modal dialog; it is a projection of manager-owned state, so the UI
   * never derives it from watcher events.
   */
  externalState: ExternalState;
}

/** Lightweight projection consumed by React. */
export interface DocumentManagerSnapshot {
  /**
   * The active document, or `null` when no document is open.
   *
   * 003 supersedes the 002 rule that a document always exists: `null` holds if
   * and only if `tabs` is empty, and the Empty State is UI only — it is never
   * represented by a session.
   */
  activeDocumentId: DocumentId | null;
  tabs: readonly TabSnapshot[];
}

/** Shown whenever a document has no disk destination yet. */
export const UNTITLED_DISPLAY_NAME = "Untitled";

/**
 * Format of a brand new document: UTF-8 without BOM and CRLF line endings,
 * matching the Windows-oriented defaults of this milestone.
 */
export const NEW_DOCUMENT_FORMAT: TextFormat = {
  encoding: "utf8",
  bom: "none",
  detectedLineEnding: "none",
  preferredLineEnding: "crlf",
};

/** A fresh reading position for a document the shared view has never shown. */
export function createDefaultViewState(): DocumentViewState {
  return { scrollTop: 0, scrollLeft: 0 };
}

/**
 * The disk revision the session last adopted, or `null` when it is unknown.
 *
 * `pathIdentity` stays the single owner of path identity, and its `diskRevision`
 * is the single owner of "which disk metadata the baseline corresponds to". A
 * `null` revision on a bound session is meaningful: the baseline was never
 * confirmed against metadata (for instance a re-inspection failed right after a
 * successful write), so validation must escalate to a content read rather than
 * trusting a revision comparison.
 */
export function sessionDiskRevision(
  session: DocumentSession,
): DiskRevision | null {
  return session.pathIdentity?.diskRevision ?? null;
}

/** Derives the window-title filename from a path, tolerating `\` and `/`. */
export function displayNameForPath(path: string | null): string {
  if (path === null) {
    return UNTITLED_DISPLAY_NAME;
  }

  const trimmed = path.replace(/[\\/]+$/, "");
  const base = trimmed === "" ? path : trimmed;
  const separatorIndex = Math.max(base.lastIndexOf("\\"), base.lastIndexOf("/"));
  const name = separatorIndex === -1 ? base : base.slice(separatorIndex + 1);

  return name === "" ? UNTITLED_DISPLAY_NAME : name;
}

/**
 * The display name for the `sequence`-th untitled document.
 *
 * The counter that feeds this only ever increases, so a number is never reused
 * after its document is saved or closed.
 */
export function untitledDisplayName(sequence: number): string {
  return `Untitled${sequence}`;
}

let documentIdSequence = 0;

/**
 * Allocates the next stable document identity.
 *
 * Process-local and monotonic: identities are unique among live sessions and
 * never collide with a session that was created earlier.
 */
export function createDocumentId(): DocumentId {
  documentIdSequence += 1;
  return `doc-${documentIdSequence}`;
}
