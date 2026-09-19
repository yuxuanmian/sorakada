/**
 * Explorer Collapse All and Locate Current File (007 T112..T120).
 *
 * Both are explicit user requests, and both are bounded by the same rule: 007's
 * Explorer may only ever read directories that are already represented, one level
 * at a time, and it must never fall back to a recursive filename search
 * (FR-052, FR-053, SC-003).
 *
 * The locate coordinator is deliberately a plain function over an injected tree
 * port, so the ancestor-chain walk can be tested against a recording reader
 * without a rendered Tree or a desktop shell.
 */

import type { DocumentId } from "../document/documentSession";
import type { WorkContext, WorkContextId } from "../workspace/workContext";
import { pathComponents, relativeWithinDirectory } from "../workspace/workContext";
import type { ExplorerNode } from "./explorerModel";

/** What the coordinator needs from the Tree, and nothing more. */
export interface LocateTreePort {
  /** The active Workspace, or `null`. */
  getContext(): WorkContext | null;
  /** The represented root's path, or `null` while no Workspace is open. */
  getRepresentedRootPath(): string | null;
  /** Any represented node by logical path. */
  getNode(path: string): ExplorerNode | null;
  /** Whether a represented directory's load succeeded. */
  isDirectoryLoaded(path: string): boolean;
  /** Expands a directory, reading it the first time. */
  expandDirectory(path: string): Promise<void>;
  /** Re-reads one represented directory's direct children. */
  reconcileDirectory(path: string): Promise<unknown>;
  /** Waits until no directory read is still running. */
  whenIdle(): Promise<void>;
  /** Selects the located entry. */
  selectPath(path: string): void;
}

/**
 * The intent captured *before* any asynchronous reveal begins (T115).
 *
 * Every field is an identity, not a value that can drift: the document id, its
 * current bound path and its canonical comparison key, plus the WorkContext id.
 * A completion that no longer matches all four is stale and cannot select a path
 * in a replacement Workspace (FR-052, T116).
 */
export interface LocateRequest {
  documentId: DocumentId;
  /** The document's user-facing path. */
  path: string;
  /** The document's canonical comparison key, from `pathIdentity`. */
  pathKey: string;
  /** The WorkContext the request was made against. */
  contextId: WorkContextId;
}

export type LocateRejectionReason =
  /** The document has no disk path (Untitled). */
  | "untitled"
  /** No Workspace is open. */
  | "no-workspace"
  /** The document is not inside the active Workspace. */
  | "outside-workspace"
  /** A component of the path is not represented, or is not a directory. */
  | "missing-component"
  /** The intent was superseded by a document or WorkContext change. */
  | "stale";

/** The outcome of one locate attempt. */
export type LocateOutcome =
  | { status: "located"; path: string }
  | { status: "rejected"; reason: LocateRejectionReason };

export interface LocateCoordinatorDeps {
  tree: LocateTreePort;
  /**
   * Whether the captured intent is still current.
   *
   * Called after every asynchronous step, so a document switch, a Workspace
   * replacement or an active-document rebind during the reveal discards the
   * remaining work instead of selecting a path in the new state (FR-052).
   */
  isCurrent(request: LocateRequest): boolean;
}

/**
 * The ancestor chain of a document inside its Workspace, outermost first.
 *
 * `null` means the document is not inside the Workspace at all. Containment is
 * decided by canonical components (`relativeWithinDirectory`), never by a
 * `startsWith()` check, so a sibling whose name merely shares a prefix is not
 * treated as a descendant (FR-075, T118).
 */
export function locateRelativeChain(
  context: WorkContext,
  request: LocateRequest,
): { components: string[] } | null {
  const relativeKey = relativeWithinDirectory(
    context.comparisonKey,
    request.pathKey,
  );
  if (relativeKey === null) {
    return null;
  }
  // The canonical key is case-folded on Windows, so the user-facing path supplies
  // the spelling the Tree actually stores.
  const displayComponents = pathComponents(request.path);
  const keyComponents = pathComponents(request.pathKey);
  const rootComponentCount = keyComponents.length - pathComponents(relativeKey).length;

  const components =
    displayComponents.length === keyComponents.length
      ? displayComponents.slice(rootComponentCount)
      : pathComponents(relativeKey);

  return { components };
}

/** Finds the child of `parentPath` whose name matches `component`. */
function findChild(
  tree: LocateTreePort,
  parentPath: string,
  component: string,
): ExplorerNode | null {
  const parent = tree.getNode(parentPath);
  if (parent === null || parent.kind !== "directory") {
    return null;
  }

  const children = parent.children ?? [];
  // Exact spelling first — the document's path came from the filesystem — with a
  // case-insensitive fallback for platforms that fold names.
  const exact = children.find((child) => child.name === component);
  if (exact !== undefined) {
    return exact;
  }
  const folded = component.toLowerCase();
  return children.find((child) => child.name.toLowerCase() === folded) ?? null;
}

/**
 * Makes one directory level's children available *and* visible.
 *
 * Three states have to be handled, and they are genuinely different:
 *
 * - **never read** — the canonical expansion loads it and reveals it;
 * - **read but collapsed** — the children are cached, so only expansion is
 *   needed, and nothing is re-read;
 * - **read in flight** — a locate issued right after a folder was opened must not
 *   race the running read; it waits for it to settle instead, which starts no new
 *   I/O at all.
 *
 * A directory whose previous read *failed* is expanded (so its error row is
 * visible and the user can see why) but never re-read: retrying a failing
 * directory is what Refresh is for (004/006).
 */
async function ensureLevelAvailable(
  tree: LocateTreePort,
  path: string,
): Promise<void> {
  const node = tree.getNode(path);
  if (node === null || node.kind !== "directory") {
    return;
  }

  if (node.loadState === "loading") {
    await tree.whenIdle();
  }

  const settled = tree.getNode(path);
  if (settled === null || settled.kind !== "directory") {
    return;
  }
  if (!settled.expanded) {
    await tree.expandDirectory(path);
  }
}

/**
 * Reveals the active document inside the current Workspace.
 *
 * The walk expands exactly the directories on the document's ancestor chain, one
 * level at a time, and stops at the first missing or unreadable component: it
 * never searches, never enumerates siblings and never touches document state
 * (FR-052, FR-053).
 *
 * **Loading and expanding are different requirements.** The visible-row
 * projection only descends through *expanded* directories, so an ancestor that is
 * already read but collapsed — the state a user leaves behind after collapsing a
 * branch they had opened — would still hide the target: the walk would succeed
 * from the cache and select a path with no row to reveal. Every ancestor on the
 * chain is therefore expanded as well as loaded (FR-052, T119).
 */
export async function locateCurrentFile(
  request: LocateRequest,
  deps: LocateCoordinatorDeps,
): Promise<LocateOutcome> {
  const { tree } = deps;

  const context = tree.getContext();
  if (context === null) {
    return { status: "rejected", reason: "no-workspace" };
  }
  if (context.id !== request.contextId) {
    return { status: "rejected", reason: "stale" };
  }

  const rootPath = tree.getRepresentedRootPath();
  if (rootPath === null) {
    return { status: "rejected", reason: "no-workspace" };
  }

  const chain = locateRelativeChain(context, request);
  if (chain === null) {
    return { status: "rejected", reason: "outside-workspace" };
  }
  const { components } = chain;
  if (components.length === 0) {
    // The document *is* the Workspace root: selecting it is already the answer.
    tree.selectPath(rootPath);
    return { status: "located", path: rootPath };
  }

  // A collapsed root hides everything below it, including a direct child, and a
  // root whose read is still running has no children to walk yet.
  await ensureLevelAvailable(tree, rootPath);
  if (!deps.isCurrent(request)) {
    return { status: "rejected", reason: "stale" };
  }

  // Every component except the last is a directory that has to be on the chain —
  // present *and* expanded.
  let parentPath = rootPath;
  for (let index = 0; index < components.length - 1; index += 1) {
    let child = findChild(tree, parentPath, components[index]);

    if (child === null) {
      await ensureLevelAvailable(tree, parentPath);
      if (!deps.isCurrent(request)) {
        return { status: "rejected", reason: "stale" };
      }
      child = findChild(tree, parentPath, components[index]);
    }

    if (child === null || child.kind !== "directory") {
      return { status: "rejected", reason: "missing-component" };
    }

    if (!child.expanded || child.children === undefined) {
      await ensureLevelAvailable(tree, child.path);
      if (!deps.isCurrent(request)) {
        return { status: "rejected", reason: "stale" };
      }
      // Re-resolve: expanding may have reconciled the parent, which can replace
      // child records.
      const expanded = tree.getNode(child.path);
      if (expanded === null || expanded.kind !== "directory") {
        return { status: "rejected", reason: "missing-component" };
      }
      child = expanded;
    }

    parentPath = child.path;
  }

  const targetComponent = components[components.length - 1];
  let target = findChild(tree, parentPath, targetComponent);

  if (target === null) {
    // The file's own directory has to be expanded and read as well.
    await ensureLevelAvailable(tree, parentPath);
    if (!deps.isCurrent(request)) {
      return { status: "rejected", reason: "stale" };
    }
    target = findChild(tree, parentPath, targetComponent);
  }

  if (target === null && tree.isDirectoryLoaded(parentPath)) {
    // The directory was read before the file existed and the 006 watcher has not
    // converged yet. One bounded re-read of the file's *own* directory is the only
    // extra read Locate may perform; it never walks a sibling branch (FR-052).
    await tree.reconcileDirectory(parentPath);
    if (!deps.isCurrent(request)) {
      return { status: "rejected", reason: "stale" };
    }
    target = findChild(tree, parentPath, targetComponent);
  }

  if (target === null) {
    return { status: "rejected", reason: "missing-component" };
  }

  // The last identity check before anything is selected: a rebind during the
  // final read must not reveal the old path.
  if (!deps.isCurrent(request)) {
    return { status: "rejected", reason: "stale" };
  }

  tree.selectPath(target.path);
  return { status: "located", path: target.path };
}
