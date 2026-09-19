import { invoke } from "@tauri-apps/api/core";

import type { Bom, LineEnding, TextFormat } from "../app/document/documentSession";

/** Stable programmatic categories returned by the Rust file commands. */
export type FileCommandCode =
  | "io_read"
  | "io_write"
  | "unsupported_encoding"
  | "unsupported_binary"
  | "unsupported_line_ending"
  | "path_resolution"
  // 003 structural Workspace codes. They are carried by the same error shape as
  // the 002 codes, so every existing consumer keeps working.
  | "io_directory"
  | "io_create"
  | "io_rename"
  | "io_trash"
  // 005: a create-if-absent write found the target already present. It is carried
  // by the same error shape and is what turns a recreate race into a reappearance
  // decision instead of an overwrite (FR-045).
  | "already_exists";

/** Serializable error returned by the Rust file commands. */
export interface FileCommandError {
  code: FileCommandCode;
  message: string;
}

/** Successful result of `read_text_file`, normalized to LF. */
export interface OpenTextFileResult {
  text: string;
  format: TextFormat;
}

/** Payload of `write_text_file`, serialized from a CodeMirror document. */
export interface WriteTextFileRequest {
  path: string;
  text: string;
  bom: Bom;
  lineEnding: LineEnding;
}

/** What a resolved path currently is. */
export type ResolvedPathKind = "file" | "directory" | "missing";

/**
 * Lightweight metadata captured for a disk object.
 *
 * Stored with disk-backed sessions as the extension point for later
 * external-change validation; 002 never polls or compares it continuously.
 */
export interface DiskRevision {
  size: number;
  modifiedTimeMillis: number | null;
}

/**
 * Result of `inspect_file_path`.
 *
 * `canonicalPath` is internal resolution detail; the UI keeps showing the
 * document's normal path. `comparisonKey` is the only key the multi-document
 * model uses for open-session ownership and Save As target claims.
 */
export interface ResolvedPathIdentity {
  requestedPath: string;
  canonicalPath: string;
  comparisonKey: string;
  kind: ResolvedPathKind;
  diskRevision: DiskRevision | null;
  /**
   * Opaque identity of the object this path resolves to (006).
   *
   * It is *not* an ownership key: `comparisonKey` keeps owning path and
   * destination semantics exactly as before. This token adds the one fact a
   * canonical path cannot carry — whether the object at a *different* path is
   * the same filesystem object — which is what makes a confirmed external
   * rename/move provable instead of guessed. The frontend never parses it, never
   * case-folds it and never compares it against a Tree-entry token; `null` means
   * the platform could not supply one, and continuity then simply cannot be
   * claimed.
   */
  objectIdentity: string | null;
}

/**
 * What a bound document path currently is, as external-change validation needs
 * to know it.
 *
 * `missing` and `unreadable` are deliberately separate: an external delete must
 * become `missing`, while a transient read/inspection failure must never be
 * converted into one (FR-014, FR-015).
 */
export type DocumentPathState = "file" | "directory" | "missing" | "unreadable";

/**
 * Result of `inspect_document_path`.
 *
 * This is the validation-oriented counterpart of `ResolvedPathIdentity`: it
 * always resolves, and reports a failure to verify as `unreadable` instead of
 * rejecting, so a validation caller can distinguish "gone" from "cannot tell".
 */
export interface DocumentPathInspection {
  requestedPath: string;
  /** Resolved candidate path; `null` when the path could not be resolved at all. */
  canonicalPath: string | null;
  /** Comparison identity key; `null` when the path could not be resolved at all. */
  comparisonKey: string | null;
  state: DocumentPathState;
  /** Metadata when the target exists; `null` for `missing` and `unreadable`. */
  diskRevision: DiskRevision | null;
  /** Why the path could not be verified; only set for `unreadable`. */
  message: string | null;
}

/**
 * The file operations the document lifecycle depends on.
 *
 * Keeping this an interface (rather than importing `invoke` directly in the
 * manager) is what makes the lifecycle logic testable without a desktop shell.
 */
export interface FileService {
  readTextFile(path: string): Promise<OpenTextFileResult>;
  writeTextFile(request: WriteTextFileRequest): Promise<void>;
  /**
   * Creates `request.path`, refusing to replace it when it already exists.
   *
   * This is the recreate path of a `missing` document (FR-030, FR-045). Unlike
   * `writeTextFile` it is atomic about absence: the Rust side opens the target with
   * create-new semantics, so a file that appeared between the final validation and
   * this write is reported as an `already_exists` error instead of being silently
   * overwritten. Nothing else about the encoding contract changes.
   */
  createTextFileIfAbsent(request: WriteTextFileRequest): Promise<void>;
  /**
   * Resolves a path to its comparison identity without touching its contents.
   *
   * `allowMissing` lets Save As resolve a destination that does not exist yet
   * through its nearest existing parent.
   */
  inspectFilePath(
    path: string,
    allowMissing: boolean,
  ): Promise<ResolvedPathIdentity>;
  /**
   * Inspects a bound document path for external-change validation.
   *
   * Unlike `inspectFilePath` this never rejects: `missing` and `unreadable` are
   * explicit states, which is what keeps a locked or permission-denied file from
   * being mistaken for an externally deleted one (FR-013–FR-015).
   */
  inspectDocumentPath(path: string): Promise<DocumentPathInspection>;
}

/** Narrows an unknown rejection value to the contract's error shape. */
export function isFileCommandError(value: unknown): value is FileCommandError {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === "string" && typeof candidate.message === "string"
  );
}

/**
 * Normalizes anything a rejected `invoke` produced into a `FileCommandError`.
 *
 * Tauri rejects with the serialized Rust error, but a transport-level failure
 * (or a bug) can surface as a plain `Error` or string, which still has to reach
 * the user as a readable message.
 */
export function toFileCommandError(
  error: unknown,
  fallbackCode: FileCommandCode,
): FileCommandError {
  if (isFileCommandError(error)) {
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return { code: fallbackCode, message: error };
  }

  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message };
  }

  return { code: fallbackCode, message: String(error) };
}

/** The real file service, backed by the Rust `read_text_file`/`write_text_file`/`inspect_file_path` commands. */
export const tauriFileService: FileService = {
  readTextFile(path: string): Promise<OpenTextFileResult> {
    return invoke<OpenTextFileResult>("read_text_file", { path });
  },

  writeTextFile(request: WriteTextFileRequest): Promise<void> {
    return invoke<void>("write_text_file", { request });
  },

  createTextFileIfAbsent(request: WriteTextFileRequest): Promise<void> {
    return invoke<void>("create_text_file_if_absent", { request });
  },

  inspectFilePath(
    path: string,
    allowMissing: boolean,
  ): Promise<ResolvedPathIdentity> {
    return invoke<ResolvedPathIdentity>("inspect_file_path", {
      request: { path, allowMissing },
    });
  },

  inspectDocumentPath(path: string): Promise<DocumentPathInspection> {
    return invoke<DocumentPathInspection>("inspect_document_path", {
      request: { path },
    });
  },
};
