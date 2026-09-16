import { invoke } from "@tauri-apps/api/core";

import type { Bom, LineEnding, TextFormat } from "../app/document/documentSession";

/** Stable programmatic categories returned by the Rust file commands. */
export type FileCommandCode =
  | "io_read"
  | "io_write"
  | "unsupported_encoding"
  | "unsupported_binary"
  | "unsupported_line_ending";

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

/**
 * The file operations the document lifecycle depends on.
 *
 * Keeping this an interface (rather than importing `invoke` directly in the
 * controller) is what makes the lifecycle logic testable without a desktop
 * shell.
 */
export interface FileService {
  readTextFile(path: string): Promise<OpenTextFileResult>;
  writeTextFile(request: WriteTextFileRequest): Promise<void>;
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

/** The real file service, backed by the Rust `read_text_file`/`write_text_file` commands. */
export const tauriFileService: FileService = {
  readTextFile(path: string): Promise<OpenTextFileResult> {
    return invoke<OpenTextFileResult>("read_text_file", { path });
  },

  writeTextFile(request: WriteTextFileRequest): Promise<void> {
    return invoke<void>("write_text_file", { request });
  },
};
