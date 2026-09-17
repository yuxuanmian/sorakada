import { invoke } from "@tauri-apps/api/core";

import type { Bom, LineEnding, TextFormat } from "../app/document/documentSession";

/** Stable programmatic categories returned by the Rust file commands. */
export type FileCommandCode =
  | "io_read"
  | "io_write"
  | "unsupported_encoding"
  | "unsupported_binary"
  | "unsupported_line_ending"
  | "path_resolution";

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
   * Resolves a path to its comparison identity without touching its contents.
   *
   * `allowMissing` lets Save As resolve a destination that does not exist yet
   * through its nearest existing parent.
   */
  inspectFilePath(
    path: string,
    allowMissing: boolean,
  ): Promise<ResolvedPathIdentity>;
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

  inspectFilePath(
    path: string,
    allowMissing: boolean,
  ): Promise<ResolvedPathIdentity> {
    return invoke<ResolvedPathIdentity>("inspect_file_path", {
      request: { path, allowMissing },
    });
  },
};
