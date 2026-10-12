import { useEffect, useRef, type KeyboardEvent } from "react";

import { AppIcon } from "../shell/AppIcon";
import type { SearchController } from "./searchController";
import { formatMatchCountLabel, type SearchState } from "./searchModel";

import "../../styles/search.css";

export interface SearchReplaceBarProps {
  controller: SearchController;
  state: SearchState;
}

/**
 * Pinned Search and Replace Bar (IntelliJ IDEA style).
 *
 * Sits directly atop the editor host below the tab strip.
 * Supports single-row Find mode (Ctrl+F) and dual-row Replace mode (Ctrl+R).
 */
export function SearchReplaceBar({ controller, state }: SearchReplaceBarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus and selection handling upon opening or mode change
  useEffect(() => {
    if (state.mode === "find") {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    } else if (state.mode === "replace") {
      if (state.query.length > 0) {
        replaceInputRef.current?.focus();
        replaceInputRef.current?.select();
      } else {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
  }, [state.mode]);

  if (state.mode === "closed") {
    return null;
  }

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        controller.findPrevious();
      } else {
        controller.findNext();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      controller.close();
    } else if (e.altKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      controller.toggleCaseSensitive();
    } else if (e.ctrlKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      controller.open("replace");
    }
  };

  const handleReplaceKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      controller.replaceNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      controller.close();
    } else if (e.altKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      controller.replaceNext();
    } else if (e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      controller.replaceAll();
    } else if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      controller.open("find");
    }
  };

  const countLabel = formatMatchCountLabel(
    state.query,
    state.matchCount,
    state.matchIndex,
    state.isCapped,
  );

  const hasMatches = state.matchCount > 0;

  return (
    <div className="search-replace-bar" role="search" aria-label="Find and Replace">
      {/* Search Row */}
      <div className="search-replace-bar__row">
        <span className="search-replace-bar__icon" aria-hidden="true">
          <AppIcon name="search" />
        </span>

        <div className="search-replace-bar__input-wrapper">
          <input
            ref={searchInputRef}
            className="search-replace-bar__input"
            type="text"
            value={state.query}
            onChange={(e) => controller.setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索"
            aria-label="搜索文本"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className={`search-replace-bar__toggle-btn ${
              state.caseSensitive ? "search-replace-bar__toggle-btn--active" : ""
            }`}
            onClick={() => controller.toggleCaseSensitive()}
            title="区分大小写 (Alt+C)"
            aria-label="区分大小写"
            aria-pressed={state.caseSensitive}
          >
            Cc
          </button>
        </div>

        <span className="search-replace-bar__count" aria-live="polite">
          {countLabel}
        </span>

        <div className="search-replace-bar__actions">
          <button
            type="button"
            className="search-replace-bar__icon-btn"
            onClick={() => controller.findPrevious()}
            disabled={!hasMatches}
            title="上一个 (Shift+Enter)"
            aria-label="上一个匹配项"
          >
            <AppIcon name="arrow-up" />
          </button>
          <button
            type="button"
            className="search-replace-bar__icon-btn"
            onClick={() => controller.findNext()}
            disabled={!hasMatches}
            title="下一个 (Enter)"
            aria-label="下一个匹配项"
          >
            <AppIcon name="arrow-down" />
          </button>
          <button
            type="button"
            className="search-replace-bar__icon-btn"
            onClick={() => controller.close()}
            title="关闭 (Esc)"
            aria-label="关闭搜索栏"
          >
            <AppIcon name="close" />
          </button>
        </div>
      </div>

      {/* Replace Row (only in Replace mode) */}
      {state.mode === "replace" && (
        <div className="search-replace-bar__row">
          <span className="search-replace-bar__icon" aria-hidden="true" />

          <div className="search-replace-bar__input-wrapper">
            <input
              ref={replaceInputRef}
              className="search-replace-bar__input"
              type="text"
              value={state.replacement}
              onChange={(e) => controller.setReplacement(e.target.value)}
              onKeyDown={handleReplaceKeyDown}
              placeholder="替换为"
              aria-label="替换文本"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <button
            type="button"
            className="search-replace-bar__text-btn"
            onClick={() => controller.replaceNext()}
            disabled={!hasMatches}
            title="替换当前 (Alt+P)"
          >
            替换
          </button>

          <button
            type="button"
            className="search-replace-bar__text-btn"
            onClick={() => controller.replaceAll()}
            disabled={!hasMatches}
            title="全部替换 (Alt+A)"
          >
            全部替换
          </button>
        </div>
      )}
    </div>
  );
}
