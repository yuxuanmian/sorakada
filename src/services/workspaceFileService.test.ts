import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateWorkspaceEntryResult,
  ReadWorkspaceDirectoryResult,
  RenameWorkspaceEntryResult,
  ResolveWorkspaceRelationResult,
} from "./workspaceFileService";
import { tauriWorkspaceFileService } from "./workspaceFileService";

/**
 * `@tauri-apps/api/core` is mocked so these tests can assert the exact IPC
 * argument shapes. The Rust side has matching serde tests for every request and
 * response DTO, so the two halves of
 * `contracts/workspace-ipc.md` are pinned from both ends — a camelCase drift
 * here would otherwise only show up at runtime.
 */
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("tauriWorkspaceFileService.readWorkspaceDirectory (US1)", () => {
  const RESULT: ReadWorkspaceDirectoryResult = {
    requestedPath: "C:\\work",
    canonicalPath: "\\\\?\\C:\\work",
    comparisonKey: "\\\\?\\c:\\work",
    // The comparison contract comes from the backend, never from the frontend.
    caseSensitive: false,
    entries: [
      {
        name: "src",
        path: "C:\\work\\src",
        kind: "directory",
        isSymlink: false,
        objectIdentity: "win:1a2b3c4d:0000000000000001",
      },
      {
        name: "a.txt",
        path: "C:\\work\\a.txt",
        kind: "file",
        isSymlink: true,
        // A symlink entry carries its own token, not its target's.
        objectIdentity: "win:1a2b3c4d:0000000000000002",
      },
    ],
  };

  it("invokes read_workspace_directory with a nested camelCase request", async () => {
    invokeMock.mockResolvedValue(RESULT);

    await expect(
      tauriWorkspaceFileService.readWorkspaceDirectory("C:\\work"),
    ).resolves.toEqual(RESULT);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("read_workspace_directory", {
      request: { path: "C:\\work" },
    });
  });

  it("surfaces the io_directory error the Explorer reports locally", async () => {
    const error = { code: "io_directory", message: "Cannot read directory" };
    invokeMock.mockRejectedValue(error);

    await expect(
      tauriWorkspaceFileService.readWorkspaceDirectory("C:\\gone"),
    ).rejects.toEqual(error);
  });

  /**
   * T156: the comparison contract belongs to the *directory*, so the frontend
   * must carry whatever the backend reported for it — including a
   * case-sensitive directory on Windows — without folding it back into a
   * platform guess of its own.
   */
  it("carries a case-sensitive directory contract through unchanged", async () => {
    const caseSensitive: ReadWorkspaceDirectoryResult = {
      ...RESULT,
      requestedPath: "C:\\work\\real",
      canonicalPath: "\\\\?\\C:\\work\\real",
      comparisonKey: "\\\\?\\c:\\work\\real",
      caseSensitive: true,
    };
    invokeMock.mockResolvedValue(caseSensitive);

    await expect(
      tauriWorkspaceFileService.readWorkspaceDirectory("C:\\work\\real"),
    ).resolves.toEqual(caseSensitive);
    expect(invokeMock).toHaveBeenCalledWith("read_workspace_directory", {
      request: { path: "C:\\work\\real" },
    });
  });
});

describe("tauriWorkspaceFileService.createWorkspaceEntry (US5)", () => {
  const RESULT: CreateWorkspaceEntryResult = {
    path: "C:\\work\\new.txt",
    identity: {
      requestedPath: "C:\\work\\new.txt",
      canonicalPath: "\\\\?\\C:\\work\\new.txt",
      comparisonKey: "\\\\?\\c:\\work\\new.txt",
      kind: "file",
      diskRevision: { size: 0, modifiedTimeMillis: 0 },
      objectIdentity: "win:1a2b3c4d:0000000000000003",
    },
  };

  it("invokes create_workspace_entry with the camelCase parent/name/kind", async () => {
    invokeMock.mockResolvedValue(RESULT);

    await expect(
      tauriWorkspaceFileService.createWorkspaceEntry({
        parentPath: "C:\\work",
        name: "new.txt",
        kind: "file",
      }),
    ).resolves.toEqual(RESULT);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("create_workspace_entry", {
      request: { parentPath: "C:\\work", name: "new.txt", kind: "file" },
    });
  });

  it("passes the directory kind through unchanged", async () => {
    invokeMock.mockResolvedValue({
      path: "C:\\work\\sub",
      identity: {
        requestedPath: "C:\\work\\sub",
        canonicalPath: "C:\\work\\sub",
        comparisonKey: "c:\\work\\sub",
        kind: "directory",
        diskRevision: null,
        objectIdentity: "win:1a2b3c4d:0000000000000004",
      },
    } satisfies CreateWorkspaceEntryResult);

    await tauriWorkspaceFileService.createWorkspaceEntry({
      parentPath: "C:\\work",
      name: "sub",
      kind: "directory",
    });

    expect(invokeMock).toHaveBeenCalledWith("create_workspace_entry", {
      request: { parentPath: "C:\\work", name: "sub", kind: "directory" },
    });
  });

  it("surfaces the io_create error so no Tree node is committed", async () => {
    const error = { code: "io_create", message: "Already exists" };
    invokeMock.mockRejectedValue(error);

    await expect(
      tauriWorkspaceFileService.createWorkspaceEntry({
        parentPath: "C:\\work",
        name: "taken.txt",
        kind: "file",
      }),
    ).rejects.toEqual(error);
  });
});

describe("tauriWorkspaceFileService.renameWorkspaceEntry (US6)", () => {
  const RESULT: RenameWorkspaceEntryResult = {
    oldCanonicalPath: "\\\\?\\C:\\work\\before.txt",
    newPath: "C:\\work\\after.txt",
    newIdentity: {
      requestedPath: "C:\\work\\after.txt",
      canonicalPath: "\\\\?\\C:\\work\\after.txt",
      comparisonKey: "\\\\?\\c:\\work\\after.txt",
      kind: "file",
      diskRevision: { size: 3, modifiedTimeMillis: 0 },
      objectIdentity: "win:1a2b3c4d:0000000000000005",
    },
  };

  it("invokes rename_workspace_entry with the camelCase source/newName", async () => {
    invokeMock.mockResolvedValue(RESULT);

    await expect(
      tauriWorkspaceFileService.renameWorkspaceEntry({
        sourcePath: "C:\\work\\before.txt",
        newName: "after.txt",
      }),
    ).resolves.toEqual(RESULT);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("rename_workspace_entry", {
      request: { sourcePath: "C:\\work\\before.txt", newName: "after.txt" },
    });
  });

  it("surfaces the io_rename error so paths stay unchanged", async () => {
    const error = { code: "io_rename", message: "Already exists" };
    invokeMock.mockRejectedValue(error);

    await expect(
      tauriWorkspaceFileService.renameWorkspaceEntry({
        sourcePath: "C:\\work\\before.txt",
        newName: "taken.txt",
      }),
    ).rejects.toEqual(error);
  });
});

describe("tauriWorkspaceFileService.trashWorkspaceEntry (US7)", () => {
  it("invokes trash_workspace_entry with a nested camelCase request", async () => {
    invokeMock.mockResolvedValue(undefined);

    await expect(
      tauriWorkspaceFileService.trashWorkspaceEntry("C:\\work\\a.txt"),
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("trash_workspace_entry", {
      request: { path: "C:\\work\\a.txt" },
    });
  });

  it("surfaces the io_trash error instead of falling back to a permanent delete", async () => {
    const error = { code: "io_trash", message: "Cannot move to the recycle bin" };
    invokeMock.mockRejectedValue(error);

    await expect(
      tauriWorkspaceFileService.trashWorkspaceEntry("C:\\work\\a.txt"),
    ).rejects.toEqual(error);
  });
});

describe("tauriWorkspaceFileService.resolveWorkspaceRelation (US3)", () => {
  it("invokes resolve_workspace_relation with the camelCase root/target", async () => {
    const result: ResolveWorkspaceRelationResult = {
      type: "inside",
      relativePath: "src\\a.ts",
    };
    invokeMock.mockResolvedValue(result);

    await expect(
      tauriWorkspaceFileService.resolveWorkspaceRelation({
        rootPath: "C:\\work",
        targetPath: "C:\\work\\src\\a.ts",
      }),
    ).resolves.toEqual(result);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("resolve_workspace_relation", {
      request: { rootPath: "C:\\work", targetPath: "C:\\work\\src\\a.ts" },
    });
  });

  it("passes an outside result through untouched", async () => {
    invokeMock.mockResolvedValue({ type: "outside" });

    await expect(
      tauriWorkspaceFileService.resolveWorkspaceRelation({
        rootPath: "C:\\work",
        targetPath: "D:\\elsewhere\\a.ts",
      }),
    ).resolves.toEqual({ type: "outside" });
  });
});
