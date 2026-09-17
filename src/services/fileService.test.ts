import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isFileCommandError,
  tauriFileService,
  toFileCommandError,
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
