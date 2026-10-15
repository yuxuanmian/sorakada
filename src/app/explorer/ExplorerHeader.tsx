/**
 * The Explorer Header (007 T106, FR-027, FR-028).
 *
 * Two stable halves:
 *
 * ```text
 * Files                          Locate  Collapse  More
 * [ query..................... ] Locate  Collapse  More
 * ```
 *
 * The right action region has a fixed layout width, so entering or leaving the
 * transient search cannot move Locate/Collapse/More horizontally (FR-027). The
 * Header is deliberately *outside* the Tree's scroll viewport, so horizontal Tree
 * scrolling never drags the actions away (FR-042).
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** The transient search presentation, or `null` for the normal header. */
export interface ExplorerSearchSlot {
  query: string;
  /** How many visible rows currently match. */
  matchCount: number;
  onQueryChange(query: string): void;
  /** Escape/clear: closes the transient search. */
  onClose(): void;
  /** Moves to the next/previous match. */
  onStep(direction: 1 | -1): void;
}

export interface ExplorerHeaderProps {
  /** Display name of the active Workspace, or `null`. */
  workspaceName: string | null;
  /** Transient search presentation; `null` shows the normal title. */
  search: ExplorerSearchSlot | null;
  /** The fixed right-side action region. */
  actions: ReactNode;
}

/** Renders the Explorer Header. */
export function ExplorerHeader({
  workspaceName,
  search,
  actions,
}: ExplorerHeaderProps) {
  const { t } = useTranslation();

  if (search === null) {
    return (
      <div className="explorer__header">
        <span className="explorer__title" title={workspaceName ?? undefined}>
          {workspaceName ?? t("ui.explorer.header.defaultTitle")}
        </span>
        <div className="explorer__actions">{actions}</div>
      </div>
    );
  }

  return (
    <div className="explorer__header">
      <input
        className="explorer__search-input"
        // The transient input owns text while it is open: the direct-type
        // trigger must not fire again from inside it (FR-050).
        autoFocus
        value={search.query}
        aria-label={t("ui.explorer.header.search.aria")}
        placeholder={t("ui.explorer.header.search.placeholder")}
        spellCheck={false}
        onChange={(event) => {
          search.onQueryChange(event.target.value);
        }}
        onKeyDown={(event) => {
          // Arrow keys navigate matches; Escape closes the transient search
          // without touching Tree expansion (FR-049).
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            search.onClose();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            search.onStep(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            search.onStep(-1);
          }
        }}
        onBlur={() => {
          // The search is transient: losing focus returns the Header to `Files`.
          search.onClose();
        }}
      />
      <span className="explorer__search-count" aria-live="polite">
        {search.matchCount === 0 ? t("ui.explorer.header.search.noMatches") : t("ui.explorer.header.search.matchCount", { count: search.matchCount })}
      </span>
      <div className="explorer__actions">{actions}</div>
    </div>
  );
}
