/**
 * Session metadata for the single document hosted by CodeMirror.
 *
 * The live text itself deliberately does not live here: CodeMirror owns it. This
 * module only describes *where* the document came from, *how* it must be written
 * back, and whether it currently differs from its last saved snapshot.
 */

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

/** Metadata and saved relationship for the active document. */
export interface ActiveDocumentSession {
  /** Current disk destination; `null` while the document is untitled. */
  path: string | null;
  /** Filename derived from `path`, or `Untitled`. */
  displayName: string;
  /** Format used when this document has to be written to disk. */
  format: TextFormat;
  /** Derived from the live CodeMirror document versus the saved baseline. */
  dirty: boolean;
}

/** Shown whenever the document has no disk destination yet. */
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

/** Creates the clean, pathless session an empty editor starts from. */
export function createUntitledSession(): ActiveDocumentSession {
  return {
    path: null,
    displayName: UNTITLED_DISPLAY_NAME,
    format: { ...NEW_DOCUMENT_FORMAT },
    dirty: false,
  };
}

/** Creates the clean session for a file that has just been read from disk. */
export function createOpenedSession(
  path: string,
  format: TextFormat,
): ActiveDocumentSession {
  return {
    path,
    displayName: displayNameForPath(path),
    format,
    dirty: false,
  };
}
