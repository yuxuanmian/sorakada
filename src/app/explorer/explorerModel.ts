/**
 * Explorer tree model.
 *
 * The tree mirrors *filesystem structure* only: it holds names, paths, kinds and
 * load state, never file contents. Nodes are plain mutable records — the
 * controller publishes a fresh `ExplorerState` object on every change, which is
 * the signal React renders from — and a directory's `children` are present only
 * once that directory has actually been read.
 */

import type {
  WorkspaceDirectoryEntry,
  WorkspaceEntryKind,
} from "../../services/workspaceFileService";
import type { WorkContextId } from "../workspace/workContext";

/** Observable load state of a directory node (FR-027). */
export type LoadState = "not-loaded" | "loading" | "loaded" | "error";

/** The fields every visible entry has. */
export interface ExplorerEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  isSymlink: boolean;
}

/** A visible file. */
export interface ExplorerFileNode extends ExplorerEntry {
  kind: "file";
}

/** A visible special or broken entry; displayable, never expandable. */
export interface ExplorerOtherNode extends ExplorerEntry {
  kind: "other";
}

/** A visible directory, with its lazy load state. */
export interface ExplorerDirectoryNode extends ExplorerEntry {
  kind: "directory";
  /** Whether the row is currently expanded. */
  expanded: boolean;
  /** Whether its children have been read, are being read, or failed. */
  loadState: LoadState;
  /** Cached direct children; only meaningful once loaded. */
  children?: readonly ExplorerNode[];
  /**
   * Canonical path of the directory actually read.
   *
   * Used for ancestor-cycle detection: it is a Rust-canonicalized path, so the
   * whole ancestor chain compares consistently without re-folding case rules in
   * the frontend.
   */
  resolvedCanonicalPath?: string;
  /** Localized failure text for a node whose load failed or was stopped. */
  errorMessage?: string;
}

/** One visible Explorer row. */
export type ExplorerNode =
  | ExplorerDirectoryNode
  | ExplorerFileNode
  | ExplorerOtherNode;

/**
 * The single inline create/rename editor.
 *
 * Exactly one exists at a time, and it is cancelled by Refresh or a WorkContext
 * replacement before new filesystem state is applied (FR-089).
 */
export type InlineEditState =
  | {
      type: "create-file" | "create-folder";
      parentPath: string;
      draftName: string;
    }
  | {
      type: "rename";
      sourcePath: string;
      originalName: string;
      draftName: string;
    };

/** Transient Explorer state for the active WorkContext. */
export interface ExplorerState {
  /** The Workspace this state belongs to, or `null` when none is open. */
  contextId: WorkContextId | null;
  /**
   * Token used to reject stale asynchronous results.
   *
   * A directory read that finishes after the context was replaced, or after a
   * full rebuild, must not mutate the current tree (FR-030).
   */
  generation: number;
  /** Root of the single-root tree, or `null` while no Workspace is open. */
  root: ExplorerDirectoryNode | null;
  /**
   * The persistent operation context: which entry an Explorer action targets.
   *
   * It is deliberately independent from DOM focus and from the active document.
   */
  selectedPath: string | null;
  /** The one active inline editor, if any. */
  inlineEdit: InlineEditState | null;
  /** Whether the Workspace root failed its last read (FR-088). */
  rootUnavailable: boolean;
}

/** Shown when following a directory link would repeat an ancestor (FR-034). */
export const DIRECTORY_CYCLE_MESSAGE =
  "This link points to a folder above it, so its contents are not listed.";

/** Shown while a directory read is in flight. */
export const DIRECTORY_LOADING_MESSAGE = "Loading...";

/** A fresh, empty Explorer state. */
export function createEmptyExplorerState(): ExplorerState {
  return {
    contextId: null,
    generation: 0,
    root: null,
    selectedPath: null,
    inlineEdit: null,
    rootUnavailable: false,
  };
}

/**
 * Directories first, then files/others, case-insensitively by name.
 *
 * The ordering is applied here rather than trusted from the backend so the UI
 * order stays stable across platforms and across cache/refresh paths.
 */
export function sortExplorerEntries<T extends ExplorerEntry>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((left, right) => {
    const leftDirectory = left.kind === "directory";
    const rightDirectory = right.kind === "directory";

    return (
      Number(rightDirectory) - Number(leftDirectory) ||
      left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
      left.name.localeCompare(right.name)
    );
  });
}

/** Creates a directory node that has not been read yet. */
export function createDirectoryNode(
  entry: { name: string; path: string; isSymlink?: boolean },
  options: {
    expanded?: boolean;
    resolvedCanonicalPath?: string;
  } = {},
): ExplorerDirectoryNode {
  return {
    name: entry.name,
    path: entry.path,
    kind: "directory",
    isSymlink: entry.isSymlink ?? false,
    expanded: options.expanded ?? false,
    loadState: "not-loaded",
    ...(options.resolvedCanonicalPath === undefined
      ? {}
      : { resolvedCanonicalPath: options.resolvedCanonicalPath }),
  };
}

/** Builds the node for one filesystem entry. */
export function toExplorerNode(entry: WorkspaceDirectoryEntry): ExplorerNode {
  if (entry.kind === "directory") {
    return {
      name: entry.name,
      path: entry.path,
      kind: "directory",
      isSymlink: entry.isSymlink,
      expanded: false,
      loadState: "not-loaded",
    };
  }

  if (entry.kind === "file") {
    return {
      name: entry.name,
      path: entry.path,
      kind: "file",
      isSymlink: entry.isSymlink,
    };
  }

  return {
    name: entry.name,
    path: entry.path,
    kind: "other",
    isSymlink: entry.isSymlink,
  };
}

/**
 * Replaces a directory's children with freshly read entries.
 *
 * Surviving entries keep their existing node object, which is what preserves
 * expansion, cached grandchildren and resolved identity across a Refresh
 * (FR-084). An entry whose kind changed becomes a new node, because the old
 * node's state no longer describes it.
 */
export function mergeChildren(
  existing: readonly ExplorerNode[] | undefined,
  entries: readonly WorkspaceDirectoryEntry[],
): ExplorerNode[] {
  const previous = new Map<string, ExplorerNode>();
  for (const node of existing ?? []) {
    previous.set(node.path, node);
  }

  return sortExplorerEntries(
    entries.map((entry) => {
      const node = previous.get(entry.path);
      if (node !== undefined && node.kind === entry.kind) {
        node.name = entry.name;
        node.isSymlink = entry.isSymlink;
        return node;
      }
      return toExplorerNode(entry);
    }),
  );
}

/** Finds the node at `path`, searching the whole visible tree. */
export function findNode(
  root: ExplorerDirectoryNode | null,
  path: string,
): ExplorerNode | null {
  if (root === null) {
    return null;
  }
  if (root.path === path) {
    return root;
  }

  for (const child of root.children ?? []) {
    if (child.path === path) {
      return child;
    }
    if (child.kind !== "directory") {
      continue;
    }
    const found = findNode(child, path);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

/** Finds the directory node at `path`, if that node is a directory. */
export function findDirectoryNode(
  root: ExplorerDirectoryNode | null,
  path: string,
): ExplorerDirectoryNode | null {
  const node = findNode(root, path);
  return node !== null && node.kind === "directory" ? node : null;
}

/** Finds the directory node that contains `path`, if it is visible. */
export function findParentDirectory(
  root: ExplorerDirectoryNode | null,
  path: string,
): ExplorerDirectoryNode | null {
  if (root === null) {
    return null;
  }

  for (const child of root.children ?? []) {
    if (child.path === path) {
      return root;
    }
  }

  for (const child of root.children ?? []) {
    if (child.kind !== "directory") {
      continue;
    }
    const found = findParentDirectory(child, path);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

/**
 * Canonical paths of the directories above `path`, outermost first.
 *
 * The target's own canonical path is not included: a directory that resolves to
 * one of these would repeat an ancestor and must not be traversed further.
 */
export function ancestorCanonicalPaths(
  root: ExplorerDirectoryNode | null,
  path: string,
): string[] {
  if (root === null) {
    return [];
  }

  const chain: string[] = [];

  const walk = (node: ExplorerDirectoryNode, ancestors: string[]): string[] | null => {
    if (node.path === path) {
      return ancestors;
    }

    const next =
      node.resolvedCanonicalPath === undefined
        ? ancestors
        : [...ancestors, node.resolvedCanonicalPath];

    for (const child of node.children ?? []) {
      if (child.kind !== "directory") {
        continue;
      }
      const found = walk(child, next);
      if (found !== null) {
        return found;
      }
    }

    return null;
  };

  return walk(root, chain) ?? chain;
}

/** Every visible directory node's path, outermost first. */
export function collectDirectoryPaths(
  root: ExplorerDirectoryNode | null,
): string[] {
  if (root === null) {
    return [];
  }

  const paths: string[] = [];

  const walk = (node: ExplorerDirectoryNode): void => {
    paths.push(node.path);
    for (const child of node.children ?? []) {
      if (child.kind === "directory") {
        walk(child);
      }
    }
  };

  walk(root);
  return paths;
}

/**
 * Rewrites `node`'s path (and every descendant's) after its parent entry was
 * renamed, keeping the suffix each node already had.
 *
 * It is only ever called on the renamed node itself, so the prefix test never
 * sees a sibling whose name merely starts with the renamed entry's name.
 */
export function rebaseNodePaths(
  node: ExplorerNode,
  sourcePath: string,
  newPath: string,
): void {
  if (node.path.startsWith(sourcePath)) {
    node.path = `${newPath}${node.path.slice(sourcePath.length)}`;
  }

  if (node.kind === "directory") {
    for (const child of node.children ?? []) {
      rebaseNodePaths(child, sourcePath, newPath);
    }
  }
}
