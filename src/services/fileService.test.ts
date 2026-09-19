import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isFileCommandError,
  tauriFileService,
  toFileCommandError,
  type DocumentPathInspection,
  type FileCommandCode,
  type FileCommandError,
  type OpenTextFileResult,
  type ResolvedPathIdentity,
} from "./fileService";
import type { TextFormat } from "../app/document/documentSession";

/**
 * `@tauri-apps/api/core` is mocked so these tests can assert the exact IPC
 * argument shapes. The Rust side has matching serde tests, so the two halves of
 * the `contracts/file-commands.md` wire format are pinned from both ends —
 * a camelCase drift here would otherwise only show up at runtime.
 */
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const FORMAT: TextFormat = {
  encoding: "utf8",
  bom: "utf8",
  detectedLineEnding: "crlf",
  preferredLineEnding: "crlf",
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("tauriFileService.readTextFile", () => {
  it("invokes read_text_file with a flat path argument", async () => {
    const result: OpenTextFileResult = { text: "alpha\nbeta", format: FORMAT };
    invokeMock.mockResolvedValue(result);

    await expect(
      tauriFileService.readTextFile("C:\\work\\notes.txt"),
    ).resolves.toEqual(result);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("read_text_file", {
      path: "C:\\work\\notes.txt",
    });
  });
});

describe("tauriFileService.writeTextFile", () => {
  it("invokes write_text_file with a nested camelCase request", async () => {
    invokeMock.mockResolvedValue(undefined);

    await tauriFileService.writeTextFile({
      path: "C:\\work\\notes.txt",
      text: "alpha\nbeta",
      bom: "utf8",
      lineEnding: "crlf",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    // `lineEnding` must stay camelCase: the Rust side deserializes
    // `WriteRequest` with `rename_all = "camelCase"`.
    expect(invokeMock).toHaveBeenCalledWith("write_text_file", {
      request: {
        path: "C:\\work\\notes.txt",
        text: "alpha\nbeta",
        bom: "utf8",
        lineEnding: "crlf",
      },
    });
  });
});

describe("tauriFileService.inspectFilePath", () => {
  const FILE_IDENTITY: ResolvedPathIdentity = {
    requestedPath: "C:\\work\\notes.txt",
    canonicalPath: "\\\\?\\C:\\work\\notes.txt",
    comparisonKey: "\\\\?\\c:\\work\\notes.txt",
    kind: "file",
    diskRevision: { size: 1234, modifiedTimeMillis: 1789600000000 },
    objectIdentity: "win:1a2b3c4d:0000000000000abc",
  };

  it("invokes inspect_file_path with a nested camelCase request", async () => {
    invokeMock.mockResolvedValue(FILE_IDENTITY);

    await expect(
      tauriFileService.inspectFilePath("C:\\work\\notes.txt", false),
    ).resolves.toEqual(FILE_IDENTITY);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    // `allowMissing` must stay camelCase: the Rust side deserializes
    // `InspectPathRequest` with `rename_all = "camelCase"`.
    expect(invokeMock).toHaveBeenCalledWith("inspect_file_path", {
      request: { path: "C:\\work\\notes.txt", allowMissing: false },
    });
  });

  it("passes the allowMissing flag through for a Save As candidate", async () => {
    const candidate: ResolvedPathIdentity = {
      requestedPath: "C:\\work\\brand-new.txt",
      canonicalPath: "\\\\?\\C:\\work\\brand-new.txt",
      comparisonKey: "\\\\?\\c:\\work\\brand-new.txt",
      kind: "missing",
      diskRevision: null,
      // A destination that does not exist yet has no object identity, and the
      // wire field is nullable rather than absent (FR-042).
      objectIdentity: null,
    };
    invokeMock.mockResolvedValue(candidate);

    await expect(
      tauriFileService.inspectFilePath("C:\\work\\brand-new.txt", true),
    ).resolves.toEqual(candidate);

    expect(invokeMock).toHaveBeenCalledWith("inspect_file_path", {
      request: { path: "C:\\work\\brand-new.txt", allowMissing: true },
    });
  });

  it("surfaces the path_resolution error the manager reports to the user", async () => {
    const error: FileCommandError = {
      code: "path_resolution",
      message: "Path does not exist: C:\\missing.txt",
    };
    invokeMock.mockRejectedValue(error);

    await expect(
      tauriFileService.inspectFilePath("C:\\missing.txt", false),
    ).rejects.toEqual(error);
  });
});

describe("tauriFileService.inspectDocumentPath", () => {
  /**
   * The exact JSON `src-tauri/src/commands/file.rs` pins with `serde_json`: six
   * camelCase fields, a lowercase state, and `null` for every field a failure or
   * an absence does not fill in.
   */
  const FILE_INSPECTION = {
    requestedPath: "C:\\work\\notes.txt",
    canonicalPath: "\\\\?\\C:\\work\\notes.txt",
    comparisonKey: "\\\\?\\c:\\work\\notes.txt",
    state: "file",
    diskRevision: { size: 1234, modifiedTimeMillis: 1789600000000 },
    message: null,
  } as const;

  it("invokes inspect_document_path with the nested camelCase request and decodes six fields", async () => {
    invokeMock.mockResolvedValue(FILE_INSPECTION);

    const inspection = await tauriFileService.inspectDocumentPath(
      "C:\\work\\notes.txt",
    );

    expect(inspection).toEqual(FILE_INSPECTION);
    // Both halves of the wire contract name the same six fields; a snake_case
    // drift on either side fails here or in the Rust test.
    expect(Object.keys(inspection).sort()).toEqual([
      "canonicalPath",
      "comparisonKey",
      "diskRevision",
      "message",
      "requestedPath",
      "state",
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("inspect_document_path", {
      request: { path: "C:\\work\\notes.txt" },
    });
  });

  it("decodes a missing path and an unreadable path as distinct states (FR-014, FR-015)", async () => {
    const missing: DocumentPathInspection = {
      requestedPath: "C:\\work\\gone.txt",
      canonicalPath: null,
      comparisonKey: null,
      state: "missing",
      diskRevision: null,
      message: null,
    };
    invokeMock.mockResolvedValue(missing);
    await expect(
      tauriFileService.inspectDocumentPath("C:\\work\\gone.txt"),
    ).resolves.toEqual(missing);

    const unreadable: DocumentPathInspection = {
      requestedPath: "C:\\work\\locked.txt",
      canonicalPath: null,
      comparisonKey: null,
      state: "unreadable",
      diskRevision: null,
      message: "Cannot inspect C:\\work\\locked.txt: access denied",
    };
    invokeMock.mockResolvedValue(unreadable);
    const decoded = await tauriFileService.inspectDocumentPath(
      "C:\\work\\locked.txt",
    );
    expect(decoded.state).toBe("unreadable");
    expect(decoded.message).not.toBeNull();
    // A failure to verify is never reported as an absence.
    expect(decoded.state).not.toBe("missing");
  });

  it("decodes a directory state so a replaced path is never treated as missing", async () => {
    const directory: DocumentPathInspection = {
      requestedPath: "C:\\work\\notes.txt",
      canonicalPath: "\\\\?\\C:\\work\\notes.txt",
      comparisonKey: "\\\\?\\c:\\work\\notes.txt",
      state: "directory",
      diskRevision: { size: 0, modifiedTimeMillis: 1789600000000 },
      message: null,
    };
    invokeMock.mockResolvedValue(directory);

    await expect(
      tauriFileService.inspectDocumentPath("C:\\work\\notes.txt"),
    ).resolves.toEqual(directory);
  });
});

describe("tauriFileService.createTextFileIfAbsent", () => {
  it("invokes create_text_file_if_absent with the same camelCase request as write_text_file", async () => {
    invokeMock.mockResolvedValue(undefined);

    await tauriFileService.createTextFileIfAbsent({
      path: "C:\\work\\notes.txt",
      text: "alpha\nbeta",
      bom: "none",
      lineEnding: "crlf",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    // The request type is deliberately the one `write_text_file` already uses, so
    // the encoding contract cannot drift between the two writers.
    expect(invokeMock).toHaveBeenCalledWith("create_text_file_if_absent", {
      request: {
        path: "C:\\work\\notes.txt",
        text: "alpha\nbeta",
        bom: "none",
        lineEnding: "crlf",
      },
    });
  });

  it("surfaces the already_exists refusal the recreate race depends on (FR-045)", async () => {
    const error: FileCommandError = {
      code: "already_exists",
      message:
        "File 'C:\\work\\notes.txt' already exists and was not overwritten.",
    };
    invokeMock.mockRejectedValue(error);

    await expect(
      tauriFileService.createTextFileIfAbsent({
        path: "C:\\work\\notes.txt",
        text: "alpha",
        bom: "none",
        lineEnding: "lf",
      }),
    ).rejects.toEqual(error);
    // The code is part of the closed union the document manager switches on to
    // route the race into the reappearance rules instead of an overwrite.
    expect(isFileCommandError(error)).toBe(true);
    expect(error.message).not.toBe("");
  });
});

describe("FileCommandCode", () => {
  it("carries the path_resolution code added by the inspection contract", () => {
    const code: FileCommandCode = "path_resolution";

    expect(isFileCommandError({ code, message: "boom" })).toBe(true);
    expect(toFileCommandError(new Error("IPC transport unavailable"), code)).toEqual({
      code: "path_resolution",
      message: "IPC transport unavailable",
    });
  });
});

describe("toFileCommandError", () => {
  it("passes a contract-shaped error through untouched", () => {
    const contractError = {
      code: "unsupported_binary",
      message: "The file contains binary data.",
    };

    expect(toFileCommandError(contractError, "io_read")).toBe(contractError);
  });

  it("wraps a plain Error using the caller's fallback code", () => {
    expect(toFileCommandError(new Error("IPC transport unavailable"), "io_read")).toEqual({
      code: "io_read",
      message: "IPC transport unavailable",
    });
    expect(toFileCommandError(new Error("disk full"), "io_write")).toEqual({
      code: "io_write",
      message: "disk full",
    });
  });

  it("wraps a raw string rejection", () => {
    expect(toFileCommandError("permission denied", "io_write")).toEqual({
      code: "io_write",
      message: "permission denied",
    });
  });

  it("falls back to a string form for anything else", () => {
    expect(toFileCommandError(undefined, "io_read")).toEqual({
      code: "io_read",
      message: "undefined",
    });
  });
});

describe("isFileCommandError", () => {
  it("accepts only objects carrying both contract fields", () => {
    expect(
      isFileCommandError({ code: "io_read", message: "boom" }),
    ).toBe(true);
    expect(isFileCommandError({ code: "io_read" })).toBe(false);
    expect(isFileCommandError({ message: "boom" })).toBe(false);
    expect(isFileCommandError(null)).toBe(false);
    expect(isFileCommandError("io_read")).toBe(false);
  });
});
