/**
 * Explorer quick search (007 T104, T105, T107, T111, FR-046..FR-050).
 *
 * Type-to-search is a *navigation* aid over what is already on screen: it matches
 * only the current visible-row projection, so it can never turn the Explorer into
 * an indexer (FR-047, SC-002). Everything here is pure, which is what makes the
 * "zero filesystem reads" and "stale index" properties provable.
 *
 * Two identity rules matter:
 *
 * 1. Matches are stored as **logical row keys**, never as array indexes, so a
 *    watcher update that adds or removes rows before a match cannot make the UI
 *    activate the wrong entry (FR-048).
 * 2. When the current match disappears, the selection moves to the next valid
 *    match — or clears — rather than keeping a stale position (T111).
 */

import type { VisibleExplorerRow } from "./explorerProjection";

/**
 * Case-insensitive substring matching over what a row shows.
 *
 * A row matches on its displayed label (the file name) or on its logical path, so
 * typing a parent folder name narrows the list without any disk access. Fuzzy
 * matching is deliberately not required by 007.
 */
export function matchesQuery(
  row: VisibleExplorerRow,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery === "") {
    return false;
  }

  const label = rowLabelText(row).toLowerCase();
  if (label.includes(normalizedQuery)) {
    return true;
  }

  return rowPathText(row).toLowerCase().includes(normalizedQuery);
}

function rowLabelText(row: VisibleExplorerRow): string {
  if (row.kind === "node") {
    return row.node.name;
  }
  if (row.kind === "notice") {
    return row.message;
  }
  return row.edit.draftName;
}

function rowPathText(row: VisibleExplorerRow): string {
  if (row.kind === "node") {
    return row.path;
  }
  if (row.kind === "notice") {
    return row.parentPath;
  }
  return row.parentPath;
}

/**
 * Every matching row's logical key, in projection order.
 *
 * An empty or whitespace-only query matches nothing: the transient search is
 * either closed or waiting for input, never "everything".
 */
export function matchVisibleRowKeys(
  rows: readonly VisibleExplorerRow[],
  query: string,
): string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") {
    return [];
  }

  const keys: string[] = [];
  for (const row of rows) {
    if (matchesQuery(row, normalized)) {
      keys.push(row.key);
    }
  }
  return keys;
}

/**
 * Which match to select after the projection or the query changed.
 *
 * The previous key is kept while it is still a match, so a background
 * reconciliation that adds rows does not move the user's current match; if it
 * disappeared, the next match in order is chosen, and an exhausted list clears the
 * selection instead of pointing at a stale index (T111).
 */
export function recommendMatchKey(
  matches: readonly string[],
  previousKey: string | null,
): string | null {
  if (matches.length === 0) {
    return null;
  }
  if (previousKey !== null && matches.includes(previousKey)) {
    return previousKey;
  }
  return matches[0];
}

/**
 * The next match, wrapping around.
 *
 * `1` moves forward, `-1` moves back; an empty match list stays empty.
 */
export function stepMatchKey(
  matches: readonly string[],
  currentKey: string | null,
  direction: 1 | -1,
): string | null {
  if (matches.length === 0) {
    return null;
  }

  const currentIndex =
    currentKey === null ? -1 : matches.indexOf(currentKey);
  if (currentIndex === -1) {
    return direction === 1 ? matches[0] : matches[matches.length - 1];
  }

  const next = (currentIndex + direction + matches.length) % matches.length;
  return matches[next];
}

/**
 * The path a search match can *select*, or `null` when the matched row is not a
 * selectable entry.
 *
 * Only real entry rows have a logical path an Explorer selection can carry: a
 * sentinel row's key is derived from its parent (`<path>::notice:error`) and the
 * inline-create row is an editor rather than an entry. Revealing those rows still
 * scrolls to them; they simply have no selection to anchor to (US3/AC3, T226).
 */
export function selectableMatchPath(
  rows: readonly VisibleExplorerRow[],
  key: string | null,
): string | null {
  if (key === null) {
    return null;
  }
  const row = rows.find((candidate) => candidate.key === key);
  return row !== undefined && row.kind === "node" ? row.path : null;
}

/** The part of a keyboard event the direct-type trigger needs. */
export interface TypeToSearchKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Set while an IME composition owns the keystroke. */
  isComposing?: boolean;
}

/** What currently owns text input, as the trigger needs to know it. */
export interface TypeToSearchContext {
  /** An inline rename/create input currently has focus. */
  inlineEditorFocused: boolean;
  /** The transient search input itself has focus. */
  searchInputFocused: boolean;
  /** Any other text-owning control (a menu text field, a dialog) has focus. */
  otherTextControlFocused: boolean;
}

/**
 * The character a keystroke should seed the transient search with, or `null`.
 *
 * The exclusions are FR-046/FR-050: a shortcut (Ctrl/Alt/Meta), an IME
 * composition, or any control that already owns text must never be hijacked by
 * the Explorer's direct-type trigger.
 */
export function typeToSearchSeed(
  event: TypeToSearchKeyEvent,
  context: TypeToSearchContext,
): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }
  if (event.isComposing === true) {
    return null;
  }
  if (
    context.inlineEditorFocused ||
    context.searchInputFocused ||
    context.otherTextControlFocused
  ) {
    return null;
  }
  // Exactly one printable character: `key` is "a", "Z", "7", " " but also
  // "Enter", "F2" or "Dead" for non-typing keys.
  if ([...event.key].length !== 1) {
    return null;
  }
  return event.key;
}
