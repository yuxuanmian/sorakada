import { invoke } from "@tauri-apps/api/core";

import type { ResolvedPathIdentity } from "./fileService";

/**
 * Structural Workspace filesystem IPC.
 *
 * 003 keeps every filesystem operation on the Rust side, exactly like 002 keeps
 * text bytes there: this module is a typed `invoke` adapter and nothing else, so
 * path semantics (canonical identity, containment, one-level listing) cannot
 * drift between the two halves of the application. Wire shapes match
 * `specs/003-workspace-explorer/contracts/workspace-ipc.md`.
 */

/** What one direct child of a directory is. */
export type WorkspaceEntryKind = "file" | "directory" | "other";

/** One direct child of a directory. */
export interface WorkspaceDirectoryEntry {
  /** Final path component, exactly as the filesystem spells it. */
  name: string;
  /** User-facing path of the entry. */
  path: string;
  /** What the entry is; `other` entries are displayable but not expandable. */
  kind: WorkspaceEntryKind;
  /** Whether the entry is itself a link/reparse point. */
  isSymlink: boolean;
}

/** Result of reading exactly one directory level. */
export interface ReadWorkspaceDirectoryResult {
  /** The path exactly as the caller spelled it. */
  requestedPath: string;
  /** Canonical path of the directory actually read. */
  canonicalPath: string;
  /** Canonical identity used for ancestor-cycle checks. */
  comparisonKey: string;
  /** Direct children only; never a recursive listing. */
  entries: readonly WorkspaceDirectoryEntry[];
}

/** Request payload of `createWorkspaceEntry`. */
export interface CreateWorkspaceEntryRequest {
  parentPath: string;
  name: string;
  kind: "file" | "directory";
}

/** Result of creating one entry. */
export interface CreateWorkspaceEntryResult {
  /** User-facing path of the new entry. */
  path: string;
  /** Freshly resolved identity of the new entry. */
  identity: ResolvedPathIdentity;
}

/** Request payload of `renameWorkspaceEntry`. */
export interface RenameWorkspaceEntryRequest {
  sourcePath: string;
  newName: string;
}

/** Result of renaming one entry. */
export interface RenameWorkspaceEntryResult {
  /** Canonical path of the entry before the rename. */
  oldCanonicalPath: string;
  /** User-facing path of the entry after the rename. */
  newPath: string;
  /** Freshly resolved identity of the renamed entry. */
  newIdentity: ResolvedPathIdentity;
}

/** Request payload of `resolveWorkspaceRelation`. */
export interface ResolveWorkspaceRelationRequest {
  rootPath: string;
  targetPath: string;
}

/** Derived relation of a disk path to the active Workspace root. */
export type ResolveWorkspaceRelationResult =
  | { type: "inside"; relativePath: string }
  | { type: "outside" };

/**
 * The structural filesystem operations the Explorer depends on.
 *
 * Keeping this an interface (rather than importing `invoke` directly into the
 * Explorer) is what makes the lazy-loading, mutation and refresh logic testable
 * without a desktop shell.
 */
export interface WorkspaceFileService {
  /** Reads one directory level. */
  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult>;
  /** Creates one empty file or one directory, never overwriting. */
  createWorkspaceEntry(
    request: CreateWorkspaceEntryRequest,
  ): Promise<CreateWorkspaceEntryResult>;
  /** Renames one entry inside its current parent directory. */
  renameWorkspaceEntry(
    request: RenameWorkspaceEntryRequest,
  ): Promise<RenameWorkspaceEntryResult>;
  /** Moves one entry to the OS recycle/trash facility. */
  trashWorkspaceEntry(path: string): Promise<void>;
  /** Derives whether `targetPath` is inside the `rootPath` Workspace. */
  resolveWorkspaceRelation(
    request: ResolveWorkspaceRelationRequest,
  ): Promise<ResolveWorkspaceRelationResult>;
}

/** The real service, backed by the `*_workspace_*` Rust commands. */
export const tauriWorkspaceFileService: WorkspaceFileService = {
  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult> {
    return invoke<ReadWorkspaceDirectoryResult>("read_workspace_directory", {
      request: { path },
    });
  },

  createWorkspaceEntry(
    request: CreateWorkspaceEntryRequest,
  ): Promise<CreateWorkspaceEntryResult> {
    return invoke<CreateWorkspaceEntryResult>("create_workspace_entry", {
      request,
    });
  },

  renameWorkspaceEntry(
    request: RenameWorkspaceEntryRequest,
  ): Promise<RenameWorkspaceEntryResult> {
    return invoke<RenameWorkspaceEntryResult>("rename_workspace_entry", {
      request,
    });
  },

  trashWorkspaceEntry(path: string): Promise<void> {
    return invoke<void>("trash_workspace_entry", { request: { path } });
  },

  resolveWorkspaceRelation(
    request: ResolveWorkspaceRelationRequest,
  ): Promise<ResolveWorkspaceRelationResult> {
    return invoke<ResolveWorkspaceRelationResult>("resolve_workspace_relation", {
      request,
    });
  },
};
