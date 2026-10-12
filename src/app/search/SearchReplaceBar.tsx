import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from "react";

import { AppIcon } from "../shell/AppIcon";
import type { SearchController } from "./searchController";
import {
  formatMatchCountLabel,
  isImeKeyboardEvent,
  type SearchState,
} from "./searchModel";

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

  const [queryDraft, setQueryDraft] = useState(state.query);
  const isQueryComposingRef = useRef(false);

  const [replacementDraft, setReplacementDraft] = useState(state.replacement);
  const isReplacementComposingRef = useRef(false);

  // Sync draft query when state.query updates externally and user is not composing
  useEffect(() => {
    if (!isQueryComposingRef.current) {
      setQueryDraft(state.query);
    }
  }, [state.query]);

  // Sync draft replacement when state.replacement updates externally and user is not composing
  useEffect(() => {
    if (!isReplacementComposingRef.current) {
      setReplacementDraft(state.replacement);
    }
  }, [state.replacement]);

  // Each open command requests focus, including Ctrl+F while already in Find.
  // Query/count updates alone must never reselect the input or steal focus.
  useEffect(() => {
    if (isQueryComposingRef.current || isReplacementComposingRef.current) {
      return;
    }
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
  }, [state.mode, state.focusRequestId]);

  if (state.mode === "closed") {
    return null;
  }

  const handleQueryChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const nextVal = e.target.value;
    setQueryDraft(nextVal);
    if (!isQueryComposingRef.current) {
      controller.setQuery(nextVal);
    }
  };

  const handleQueryCompositionStart = (): void => {
    isQueryComposingRef.current = true;
  };

  const handleQueryCompositionEnd = (
    e: CompositionEvent<HTMLInputElement>,
  ): void => {
    isQueryComposingRef.current = false;
    const finalVal = e.currentTarget.value;
    setQueryDraft(finalVal);
    controller.setQuery(finalVal);
  };

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (isImeKeyboardEvent(e, isQueryComposingRef.current)) {
      // During IME composition, stop propagation so window listeners (like EscapeManager)
      // do not see the key event, but do NOT preventDefault so the IME can natively process Enter/Escape.
      e.stopPropagation();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (state.error || state.matchCount === 0 || state.query.length === 0) {
        return;
      }
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
    } else if (e.altKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      controller.toggleRegex();
    } else if (e.ctrlKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      controller.open("replace");
    }
  };

  const handleReplacementChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const nextVal = e.target.value;
    setReplacementDraft(nextVal);
    if (!isReplacementComposingRef.current) {
      controller.setReplacement(nextVal);
    }
  };

  const handleReplacementCompositionStart = (): void => {
    isReplacementComposingRef.current = true;
  };

  const handleReplacementCompositionEnd = (
    e: CompositionEvent<HTMLInputElement>,
  ): void => {
    isReplacementComposingRef.current = false;
    const finalVal = e.currentTarget.value;
    setReplacementDraft(finalVal);
    controller.setReplacement(finalVal);
  };

  const handleReplaceKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (isImeKeyboardEvent(e, isReplacementComposingRef.current)) {
      e.stopPropagation();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (state.error || state.matchCount === 0 || state.query.length === 0) {
        return;
      }
      controller.replaceNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      controller.close();
    } else if (e.altKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      if (state.error || state.matchCount === 0 || state.query.length === 0) {
        return;
      }
      controller.replaceNext();
    } else if (e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      if (state.error || state.matchCount === 0 || state.query.length === 0) {
        return;
      }
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
    state.error,
  );

  const hasMatches = state.matchCount > 0 && state.error === null;

  return (
    <div className="search-replace-bar" role="search" aria-label="Find and Replace">
      {/* Search Row */}
      <div className="search-replace-bar__row">
        <span className="search-replace-bar__icon" aria-hidden="true">
          <AppIcon name="search" />
        </span>

        <div
          className={`search-replace-bar__input-wrapper ${
            state.error ? "search-replace-bar__input-wrapper--error" : ""
          }`}
        >
          <input
            ref={searchInputRef}
            className="search-replace-bar__input"
            type="text"
            value={isQueryComposingRef.current ? queryDraft : state.query}
            onChange={handleQueryChange}
            onCompositionStart={handleQueryCompositionStart}
            onCompositionEnd={handleQueryCompositionEnd}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索"
            aria-label="搜索文本"
            aria-invalid={state.error !== null}
            aria-describedby="search-count-label"
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
          <button
            type="button"
            className={`search-replace-bar__toggle-btn ${
              state.isRegex ? "search-replace-bar__toggle-btn--active" : ""
            }`}
            onClick={() => controller.toggleRegex()}
            title="正则表达式 (Alt+R)"
            aria-label="正则表达式"
            aria-pressed={state.isRegex}
          >
            .*
          </button>
        </div>

        <span
          id="search-count-label"
          className={`search-replace-bar__count ${
            state.error ? "search-replace-bar__count--error" : ""
          }`}
          role={state.error ? "alert" : "status"}
          aria-live={state.error ? "assertive" : "polite"}
        >
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
              value={
                isReplacementComposingRef.current
                  ? replacementDraft
                  : state.replacement
              }
              onChange={handleReplacementChange}
              onCompositionStart={handleReplacementCompositionStart}
              onCompositionEnd={handleReplacementCompositionEnd}
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
