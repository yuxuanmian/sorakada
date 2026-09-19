/**
 * Transient Explorer search state (007 T107, T109, T110, T111).
 *
 * It is UI state and nothing else: it consumes the visible-row projection, holds
 * a query and the current match's *logical key*, and never touches the controller,
 * a service or the filesystem (FR-047).
 *
 * The hook is a plain `useState`/`useMemo` pair on purpose — the search is not a
 * store, because exactly one component owns it and nothing else may read or write
 * it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { VisibleExplorerRow } from "./explorerProjection";
import {
  matchVisibleRowKeys,
  recommendMatchKey,
  stepMatchKey,
} from "./explorerQuickSearch";

export interface ExplorerQuickSearch {
  /** The transient query, or `null` while the Header shows its normal state. */
  query: string | null;
  /** How many visible rows match the current query. */
  matchCount: number;
  /** The current match's logical key, or `null`. */
  currentKey: string | null;
  /** Opens the transient search seeded with the triggering character. */
  start(seed: string): void;
  /** Replaces the query. */
  update(query: string): void;
  /** Closes the search and forgets the query and match. */
  close(): void;
  /** Moves to the next/previous match. */
  step(direction: 1 | -1): void;
}

/**
 * Owns the transient search over one projection.
 *
 * Match identity is a logical row key, so a watcher-driven projection change can
 * only move the match to a valid row or clear it (FR-048, T111).
 */
export function useExplorerQuickSearch(
  rows: readonly VisibleExplorerRow[],
): ExplorerQuickSearch {
  const [query, setQuery] = useState<string | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);

  const matchKeys = useMemo(
    () => (query === null ? [] : matchVisibleRowKeys(rows, query)),
    [query, rows],
  );

  // Re-anchor the current match whenever the match set changes: kept while it is
  // still a match, otherwise the next valid one, otherwise cleared.
  useEffect(() => {
    setCurrentKey((previous) => {
      const next = recommendMatchKey(matchKeys, previous);
      return next === previous ? previous : next;
    });
  }, [matchKeys]);

  const start = useCallback((seed: string) => {
    setQuery(seed);
    setCurrentKey(null);
  }, []);

  const update = useCallback((next: string) => {
    setQuery(next);
  }, []);

  const close = useCallback(() => {
    setQuery(null);
    setCurrentKey(null);
  }, []);

  const step = useCallback(
    (direction: 1 | -1) => {
      setCurrentKey((previous) =>
        stepMatchKey(matchKeys, previous, direction),
      );
    },
    [matchKeys],
  );

  return {
    query,
    matchCount: matchKeys.length,
    currentKey,
    start,
    update,
    close,
    step,
  };
}
