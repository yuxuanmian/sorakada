/**
 * The Explorer visible-row projection (007 T081, FR-031..FR-034, FR-039, FR-040).
 *
 * The Tree is rendered from a *linear* list of rows derived from
 * `ExplorerState`, never from a recursive component. That is what allows the
 * viewport to mount only the rows it needs: the projection is a pure function of
 * the state, and the renderer only decides which slice of it to mount.
 *
 * Three rules shape it:
 *
 * 1. **Purity.** Flattening reads the materialized model and nothing else. It
 *    never asks a service for anything, never resolves a path and never
 *    enumerates an unloaded directory (FR-033, FR-044).
 * 2. **No second model.** The projection is derived on demand and is not stored;
 *    `ExplorerController` remains the only owner of selection, expansion and
 *    inline-edit state (Constitution II).
 * 3. **Stable logical identity.** Every row's key comes from the entry's logical
 *    path (or a path-derived sentinel key), never from its array position, so a
 *    recycled row can never be mistaken for another one (FR-034, FR-048).
 */

import {
  DIRECTORY_CYCLE_MESSAGE,
  DIRECTORY_LOADING_MESSAGE,
  type ExplorerDirectoryNode,
  type ExplorerNode,
  type ExplorerState,
  type InlineEditState,
} from "./explorerModel";

/** Which load/error sentinel a notice row represents. */
export type ExplorerNoticeType = "loading" | "error" | "cycle";

/** One real entry row. */
export interface VisibleExplorerNodeRow {
  kind: "node";
  /** Stable logical key; the entry's logical path. */
  key: string;
  /** The entry's logical path. */
  path: string;
  /** Depth below the root; the root itself is depth 0. */
  depth: number;
  /** The materialized entry. */
  node: ExplorerNode;
  /**
   * One flag per ancestor level above this row.
   *
   * Index `j` answers "does the ancestor at depth `j` have a following sibling?"
   * which is exactly what an IDEA-like indent guide needs to know; the guides are
   * drawn from this metadata rather than from nested ancestor containers
   * (FR-039, T093).
   */
  ancestorContinuation: readonly boolean[];
}

/**
 * One load/error/cycle sentinel row.
 *
 * Sentinels are rows like any other, so they participate in the same virtual
 * sequence and cannot break scroll positioning (FR-040). Their text is never
 * allowed to influence row height: the row is a fixed-height line whose full
 * message is available through its `title` (T082).
 */
export interface VisibleExplorerNoticeRow {
  kind: "notice";
  /** Deterministic, path-derived key. */
  key: string;
  /** The directory the notice belongs to. */
  parentPath: string;
  /** Depth of the notice row (one level below its directory). */
  depth: number;
  noticeType: ExplorerNoticeType;
  /** The full message; display truncates, the row height does not grow. */
  message: string;
  ancestorContinuation: readonly boolean[];
}

/**
 * The inline New File/New Folder editor as a row.
 *
 * A create editor is a real row inside its expanded parent, so under
 * virtualization it has to be *in* the projection: that is what lets the
 * virtualizer keep it mounted while it is being edited (T097).
 */
export interface VisibleExplorerInlineRow {
  kind: "inline";
  /** Deterministic key derived from the parent directory. */
  key: string;
  /** The directory the new entry will be created in. */
  parentPath: string;
  depth: number;
  /** The inline edit state, so the row renders the draft it owns. */
  edit: InlineEditState;
  ancestorContinuation: readonly boolean[];
}

/** One flattened, mountable Explorer row. */
export type VisibleExplorerRow =
  | VisibleExplorerNodeRow
  | VisibleExplorerNoticeRow
  | VisibleExplorerInlineRow;

/** The stable key of the rename row's target, used for reveal requests. */
export function inlineEditRowKey(edit: InlineEditState): string {
  return edit.type === "rename"
    ? edit.sourcePath
    : inlineCreateRowKey(edit.parentPath);
}

/** The deterministic key of the create row inside `parentPath`. */
export function inlineCreateRowKey(parentPath: string): string {
  return `${parentPath}::inline-create`;
}

function noticeRowKey(parentPath: string, type: ExplorerNoticeType): string {
  return `${parentPath}::notice:${type}`;
}

/**
 * Classifies the notice one directory currently shows.
 *
 * The `loading`/`error` precedence is the 004 behaviour: a directory being read
 * for the first time shows progress, and a failure shows its own localized
 * message instead. Both are rendered *in addition to* cached children, so a
 * failed refresh never hides what was already loaded (FR-029).
 */
function noticeFor(node: ExplorerDirectoryNode): {
  type: ExplorerNoticeType;
  message: string;
} | null {
  if (node.loadState === "loading" && node.children === undefined) {
    return { type: "loading", message: DIRECTORY_LOADING_MESSAGE };
  }
  if (node.errorMessage !== undefined) {
    return {
      type: node.errorMessage === DIRECTORY_CYCLE_MESSAGE ? "cycle" : "error",
      message: node.errorMessage,
    };
  }
  return null;
}

/**
 * Flattens the materialized Tree into the rows that should be visible.
 *
 * The walk always starts at the represented root and descends only through
 * expanded directories, so a collapsed ancestor contributes exactly one row and
 * no descendant can appear even when the controller still remembers its
 * expansion and cached children (FR-032, T078).
 */
export function flattenVisibleExplorerRows(
  state: ExplorerState,
): VisibleExplorerRow[] {
  const root = state.root;
  if (root === null) {
    return [];
  }

  const rows: VisibleExplorerRow[] = [];
  const edit = state.inlineEdit;

  const walkNode = (
    node: ExplorerNode,
    depth: number,
    ancestorContinuation: readonly boolean[],
  ): void => {
    rows.push({
      kind: "node",
      key: node.path,
      path: node.path,
      depth,
      node,
      ancestorContinuation,
    });

    if (node.kind !== "directory" || !node.expanded) {
      return;
    }

    const childDepth = depth + 1;

    // The create editor belongs to its parent directory and sits above the
    // cached children, exactly where 004 rendered it.
    if (
      edit !== null &&
      edit.type !== "rename" &&
      edit.parentPath === node.path
    ) {
      rows.push({
        kind: "inline",
        key: inlineCreateRowKey(node.path),
        parentPath: node.path,
        depth: childDepth,
        edit,
        ancestorContinuation: [...ancestorContinuation, true],
      });
    }

    const notice = noticeFor(node);
    if (notice !== null) {
      rows.push({
        kind: "notice",
        key: noticeRowKey(node.path, notice.type),
        parentPath: node.path,
        depth: childDepth,
        noticeType: notice.type,
        message: notice.message,
        ancestorContinuation: [...ancestorContinuation, true],
      });
    }

    const children = node.children ?? [];
    children.forEach((child, index) => {
      walkNode(child, childDepth, [
        ...ancestorContinuation,
        index < children.length - 1,
      ]);
    });
  };

  walkNode(root, 0, []);
  return rows;
}

/** What a reveal request resolves to against one projection (T110, T120). */
export interface ExplorerRevealPlan {
  /** The projection index of the requested row, or `-1` when it is not there. */
  index: number;
  /**
   * Whether the request could be serviced this time.
   *
   * A request is only "handled" once its row is actually in the projection. A
   * locate that expands a collapsed ancestor produces the row a render later, and
   * clearing the request before then would silently drop the reveal.
   */
  handled: boolean;
}

/** Resolves a logical row key against one projection. */
export function planRowReveal(
  rows: readonly VisibleExplorerRow[],
  key: string | null | undefined,
): ExplorerRevealPlan {
  if (key === null || key === undefined) {
    return { index: -1, handled: false };
  }
  const index = rows.findIndex((row) => row.key === key);
  return { index, handled: index >= 0 };
}
