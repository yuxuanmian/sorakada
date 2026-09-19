/**
 * Tab Overview projection (007 T129, T140..T142, FR-069, FR-070).
 *
 * The Overview is a *filtered view of the current Tab order*, never a second owner
 * of document metadata: it reads `TabSnapshot`s, filters by display name or path,
 * and asks the existing selection path to activate one.
 *
 * Pure, so the filtering, ordering and marker rules are provable without a DOM.
 */

import type { DocumentId, TabSnapshot } from "../document/documentSession";

/** One Overview entry: a projection of current Tab metadata. */
export interface TabOverviewItem {
  id: DocumentId;
  displayName: string;
  path: string | null;
  dirty: boolean;
  active: boolean;
  /** The 005 external disk state, shown as-is (FR-069). */
  externalState: TabSnapshot["externalState"];
}

/** Projects one snapshot into an Overview entry. */
export function toTabOverviewItem(tab: TabSnapshot): TabOverviewItem {
  return {
    id: tab.id,
    displayName: tab.displayName,
    path: tab.path,
    dirty: tab.dirty,
    active: tab.active,
    externalState: tab.externalState,
  };
}

/**
 * Filters the current Tabs, preserving Tab order.
 *
 * An empty filter lists everything, which is what makes the Overview useful as a
 * plain "which documents are open" surface. Matching is case-insensitive over the
 * display name and the path, and reads no filesystem (T140).
 */
export function filterTabOverviewItems(
  tabs: readonly TabSnapshot[],
  filter: string,
): TabOverviewItem[] {
  const normalized = filter.trim().toLowerCase();

  return tabs
    .filter((tab) => {
      if (normalized === "") {
        return true;
      }
      if (tab.displayName.toLowerCase().includes(normalized)) {
        return true;
      }
      return (tab.path ?? "").toLowerCase().includes(normalized);
    })
    .map(toTabOverviewItem);
}

/**
 * Activates one Overview entry through the canonical document path.
 *
 * The signature is the guarantee: selecting can only reach the existing
 * selection callback and the popup close. The Overview has no reachable route to
 * the document-opening pipeline, so it cannot duplicate a session for a document
 * that is already open (FR-069, FR-070, T141).
 */
export function activateTabOverviewItem(
  id: DocumentId,
  actions: {
    /** The manager's existing selection path. */
    select(id: DocumentId): void;
    /** Closes the popup. */
    close(): void;
  },
): void {
  actions.select(id);
  actions.close();
}

/**
 * The Overview entry that should be highlighted for an entry list.
 *
 * Used when a document was closed while the Overview was open: the list is
 * rebuilt from the newest snapshot, so a removed entry simply disappears and the
 * "nothing to show" state is reachable (T142).
 */
export function overviewHasItems(
  items: readonly TabOverviewItem[],
): boolean {
  return items.length > 0;
}
