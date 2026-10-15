/**
 * The Explorer's single controlled operation target (007 T069, T102).
 *
 * A context gesture happens on a region, not on a component: in 007 the Tree body
 * is the trigger and the row under the pointer is identified by a data attribute.
 * That is what keeps the operation target authoritative at the Explorer level, so
 * a virtualized row can be recycled, unmounted and re-mounted without ever owning
 * popup state or leaving a stale target behind.
 *
 * The mapping is a pure function of one element, which is why it is testable
 * without a DOM.
 */

/** The attribute every rendered Explorer row carries. */
export const EXPLORER_ROW_PATH_ATTRIBUTE = "data-explorer-row-path";

/** The minimal element surface the mapping needs. */
export interface RowPathLookup {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * The logical path of the row a gesture targeted, or `null` for blank space.
 *
 * Blank space (including the area below the last row, which belongs to the Tree
 * body) is always Workspace-root context and never a stale previous node.
 */
export function rowPathFromTarget(element: unknown): string | null {
  if (element === null || typeof element !== "object") {
    return null;
  }

  const lookup = element as { closest?: unknown };
  if (typeof lookup.closest !== "function") {
    return null;
  }

  const row = (lookup as RowPathLookup).closest(
    `[${EXPLORER_ROW_PATH_ATTRIBUTE}]`,
  );
  if (row === null) {
    return null;
  }

  const path = row.getAttribute(EXPLORER_ROW_PATH_ATTRIBUTE);
  return path === null || path === "" ? null : path;
}
