import type { AppTranslator } from "../../i18n";
import { t } from "../../i18n";
import { INVALID_REGEX_ERROR } from "./searchEngine";
/**
 * Search and replace state models, helpers, and constants.
 */

export type SearchMode = "find" | "replace" | "closed";

export interface SearchState {
  /** The current presentation mode of the search/replace bar. */
  readonly mode: SearchMode;
  /** Changes only when an open command requests input focus and text selection. */
  readonly focusRequestId: number;
  /** The search query string. */
  readonly query: string;
  /** The replacement text string. */
  readonly replacement: string;
  /** Whether search matching is case sensitive. */
  readonly caseSensitive: boolean;
  /** Whether search matching is evaluated as a regular expression. */
  readonly isRegex: boolean;
  /** In-place error message for invalid queries (e.g. invalid regex), or null. */
  readonly error: string | null;
  /** 1-based index of the currently focused match, or 0 if none. */
  readonly matchIndex: number;
  /** Total number of matches found up to the safety cap. */
  readonly matchCount: number;
  /** Whether the match count reached the safety cap (e.g. 1000). */
  readonly isCapped: boolean;
}

export const INITIAL_SEARCH_STATE: SearchState = {
  mode: "closed",
  focusRequestId: 0,
  query: "",
  replacement: "",
  caseSensitive: false,
  isRegex: false,
  error: null,
  matchIndex: 0,
  matchCount: 0,
  isCapped: false,
};

/**
 * Normalizes a candidate selection string for search query prefilling.
 *
 * Requirements (updated 2026-10-18):
 * - Accepts all non-empty selections, including multiline (\r, \n) and whitespace.
 * - No character length cap.
 * - In regex mode, escapes special regex characters to search literally while preserving newlines.
 */
export function normalizeSelectionForPrefill(
  text: string,
  isRegex = false,
): string | null {
  if (text.length === 0) {
    return null;
  }
  if (isRegex) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return text;
}

/**
 * Formats the match count label for display in the search bar.
 *
 * e.g.:
 * - query empty -> ""
 * - count === 0 -> "0 个结果"
 * - count > 0 && matchIndex > 0 -> "1 / 15" or "1 / 1000+"
 * - count > 0 && matchIndex === 0 -> "15 个结果" or "1000+ 个结果"
 * - error !== null -> error message
 */
export function formatMatchCountLabel(
  query: string,
  matchCount: number,
  matchIndex: number,
  isCapped: boolean,
  error?: string | null,
  translate: AppTranslator = t,
): string {
  if (error) {
    if (error === INVALID_REGEX_ERROR) {
      return translate("ui.search.errors.invalidRegex");
    }
    return error;
  }
  if (query.length === 0) {
    return "";
  }
  if (matchCount === 0) {
    return translate("ui.search.matches.noResults");
  }
  if (matchIndex > 0) {
    return isCapped
      ? translate("ui.search.matches.positionCapped", {
          current: matchIndex,
          total: matchCount,
        })
      : translate("ui.search.matches.position", {
          current: matchIndex,
          total: matchCount,
        });
  }
  if (isCapped) {
    return translate("ui.search.matches.countCapped", { count: matchCount });
  }
  return translate("ui.search.matches.count", { count: matchCount });
}

/**
 * Minimal structural shape of a keyboard event for IME detection without DOM dependencies.
 */
export interface KeyboardEventLike {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly key?: string;
  readonly nativeEvent?: {
    readonly isComposing?: boolean;
  };
}

/**
 * Determines whether a keyboard event belongs to an active IME composition.
 *
 * Catches:
 * - `event.isComposing` (DOM Level 3 KeyboardEvent)
 * - `event.nativeEvent.isComposing` (React SyntheticEvent)
 * - `event.keyCode === 229` (Standard IME virtual key code)
 * - `event.key === "Process"` (IME composition key value in WebKit/Edge)
 * - `isComposingState === true` (Component-tracked composition lifecycle)
 */
export function isImeKeyboardEvent(
  event: KeyboardEventLike,
  isComposingState = false,
): boolean {
  if (isComposingState) {
    return true;
  }
  if (Boolean(event.isComposing)) {
    return true;
  }
  if (Boolean(event.nativeEvent?.isComposing)) {
    return true;
  }
  if (event.keyCode === 229) {
    return true;
  }
  if (event.key === "Process") {
    return true;
  }
  return false;
}
