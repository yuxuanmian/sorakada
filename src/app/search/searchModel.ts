/**
 * Search and replace state models and constants.
 */

export type SearchMode = "find" | "replace" | "closed";

export interface SearchState {
  /** The current presentation mode of the search/replace bar. */
  readonly mode: SearchMode;
  /** The search query string. */
  readonly query: string;
  /** The replacement text string. */
  readonly replacement: string;
  /** Whether search matching is case sensitive. */
  readonly caseSensitive: boolean;
  /** 1-based index of the currently focused match, or 0 if none. */
  readonly matchIndex: number;
  /** Total number of matches found up to the safety cap. */
  readonly matchCount: number;
  /** Whether the match count reached the safety cap (e.g. 1000). */
  readonly isCapped: boolean;
}

export const INITIAL_SEARCH_STATE: SearchState = {
  mode: "closed",
  query: "",
  replacement: "",
  caseSensitive: false,
  matchIndex: 0,
  matchCount: 0,
  isCapped: false,
};

/**
 * Normalizes a candidate selection string for search query prefilling.
 *
 * Requirements (from 009 plan):
 * - Single-line only (no \r or \n).
 * - Max length of 200 characters.
 * - Non-empty after trimming.
 */
export function normalizeSelectionForPrefill(text: string): string | null {
  if (text.length === 0 || text.length > 200) {
    return null;
  }
  if (text.includes("\n") || text.includes("\r")) {
    return null;
  }
  if (text.trim().length === 0) {
    return null;
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
 */
export function formatMatchCountLabel(
  query: string,
  matchCount: number,
  matchIndex: number,
  isCapped: boolean,
): string {
  if (query.length === 0) {
    return "";
  }
  if (matchCount === 0) {
    return "0 个结果";
  }
  const capSuffix = isCapped ? "+" : "";
  if (matchIndex > 0) {
    return `${matchIndex} / ${matchCount}${capSuffix}`;
  }
  return `${matchCount}${capSuffix} 个结果`;
}
