import type { Text } from "@codemirror/state";

/**
 * Shared search matching, replacement, and navigation engine for literal and regex searches.
 */

export interface SearchMatch {
  readonly from: number;
  readonly to: number;
  readonly match: readonly string[];
  readonly isZeroWidth: boolean;
}

export interface RegexValidationResult {
  readonly valid: boolean;
  readonly error: string | null;
  readonly regex?: RegExp;
}

/**
 * Escapes special regex characters in plain text so it matches literally.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decodes standard replacement escape sequences (\\n, \\r, \\t, \\\\) in replacement strings.
 */
export function decodeEscapes(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return "\\";
  });
}

/**
 * Validates a regex query string.
 */
export const INVALID_REGEX_ERROR = "invalid-regex";

export function validateRegex(
  query: string,
  caseSensitive: boolean,
): RegexValidationResult {
  if (query.length === 0) {
    return { valid: true, error: null };
  }
  try {
    const flags = (caseSensitive ? "gm" : "gmi") + "u";
    const regex = new RegExp(query, flags);
    return { valid: true, error: null, regex };
  } catch {
    return { valid: false, error: INVALID_REGEX_ERROR };
  }
}

/**
 * Finds all matches across a document string according to search options.
 * Both literal and regex searches preserve exact UTF-16 code unit offsets.
 * Zero-width matches advance by code point to avoid surrogate pair traps under "u" flag.
 */
export function findAllMatches(
  docText: string,
  query: string,
  caseSensitive: boolean,
  isRegex: boolean,
  limit?: number,
): SearchMatch[] {
  if (query.length === 0) {
    return [];
  }

  let re: RegExp;
  if (isRegex) {
    const validation = validateRegex(query, caseSensitive);
    if (!validation.valid || !validation.regex) {
      return [];
    }
    re = validation.regex;
  } else {
    const flags = (caseSensitive ? "gm" : "gmi") + "u";
    re = new RegExp(escapeRegex(decodeEscapes(query)), flags);
  }

  const matches: SearchMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(docText)) !== null) {
    const from = match.index;
    const to = match.index + match[0].length;
    matches.push({
      from,
      to,
      match: Array.from(match),
      isZeroWidth: from === to,
    });
    if (limit !== undefined && matches.length >= limit) {
      break;
    }
    if (match[0].length === 0) {
      const codePoint = docText.codePointAt(match.index);
      const step = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
      re.lastIndex = match.index + step;
      if (re.lastIndex > docText.length) {
        break;
      }
    }
  }
  return matches;
}

interface SharedSearchCache {
  docKey: Text;
  query: string;
  caseSensitive: boolean;
  isRegex: boolean;
  matches: readonly SearchMatch[];
}

let sharedSearchCache: SharedSearchCache | null = null;

/**
 * Returns cached matches for an immutable document key (e.g. view.state.doc)
 * and search options to avoid re-scanning the entire document on cursor moves or scrolling.
 */
export function getCachedMatches(
  docKey: Text,
  query: string,
  caseSensitive: boolean,
  isRegex: boolean,
): readonly SearchMatch[] {
  if (
    sharedSearchCache !== null &&
    sharedSearchCache.docKey === docKey &&
    sharedSearchCache.query === query &&
    sharedSearchCache.caseSensitive === caseSensitive &&
    sharedSearchCache.isRegex === isRegex
  ) {
    return sharedSearchCache.matches;
  }

  const matches = findAllMatches(docKey.toString(), query, caseSensitive, isRegex);
  sharedSearchCache = {
    docKey,
    query,
    caseSensitive,
    isRegex,
    matches,
  };
  return matches;
}

/**
 * Clears the shared search match cache.
 */
export function clearSearchCache(): void {
  sharedSearchCache = null;
}

/**
 * Computes replacement text for a match.
 * In regex mode, replaces $1-$99, $&, $$, and treats unmatched optional groups as empty strings.
 * In normal mode, treats replacement text as literal string without expanding group references.
 * Decodes \\n, \\r, \\t, \\\\ in both modes.
 */
export function computeReplacement(
  replacementTemplate: string,
  match: readonly string[],
  isRegex: boolean,
): string {
  const unquoted = decodeEscapes(replacementTemplate);
  if (!isRegex) {
    return unquoted;
  }
  return unquoted.replace(/\$([$&]|[1-9]\d?)/g, (full, specifier) => {
    if (specifier === "$") {
      return "$";
    }
    if (specifier === "&") {
      return match[0] ?? "";
    }
    const groupNum = Number.parseInt(specifier, 10);
    if (groupNum > 0 && groupNum < match.length) {
      return match[groupNum] ?? "";
    }
    return full;
  });
}

/**
 * Finds the nearest match starting from or after fromPos, wrapping to index 0 if none after.
 */
export function findNearestMatch(
  matches: readonly SearchMatch[],
  fromPos: number,
): { match: SearchMatch; index: number } | null {
  if (matches.length === 0) {
    return null;
  }
  for (let i = 0; i < matches.length; i += 1) {
    if (matches[i].from >= fromPos) {
      return { match: matches[i], index: i + 1 };
    }
  }
  return { match: matches[0], index: 1 };
}

/**
 * Finds the match that preserves the previously active match during query typing.
 */
export function findPreservedMatch(
  matches: readonly SearchMatch[],
  prevRange: { from: number; to: number },
): { match: SearchMatch; index: number } | null {
  if (matches.length === 0) {
    return null;
  }
  const exact = matches.findIndex((m) => m.from === prevRange.from);
  if (exact !== -1) {
    return { match: matches[exact], index: exact + 1 };
  }
  const overlap = matches.findIndex(
    (m) => m.from <= prevRange.to && m.to >= prevRange.from,
  );
  if (overlap !== -1) {
    return { match: matches[overlap], index: overlap + 1 };
  }
  return findNearestMatch(matches, prevRange.from);
}

/**
 * Finds the next match forward with wrap-around.
 * Advances past zero-width matches reliably via array indexing.
 */
export function findNextMatch(
  matches: readonly SearchMatch[],
  currentRange: { from: number; to: number },
): { match: SearchMatch; index: number } | null {
  if (matches.length === 0) {
    return null;
  }
  const idx = matches.findIndex(
    (m) => m.from === currentRange.from && m.to === currentRange.to,
  );
  if (idx !== -1) {
    const nextIdx = (idx + 1) % matches.length;
    return { match: matches[nextIdx], index: nextIdx + 1 };
  }
  for (let i = 0; i < matches.length; i += 1) {
    if (matches[i].from >= currentRange.to) {
      return { match: matches[i], index: i + 1 };
    }
  }
  return { match: matches[0], index: 1 };
}

/**
 * Finds the previous match backward with wrap-around.
 */
export function findPreviousMatch(
  matches: readonly SearchMatch[],
  currentRange: { from: number; to: number },
): { match: SearchMatch; index: number } | null {
  if (matches.length === 0) {
    return null;
  }
  const idx = matches.findIndex(
    (m) => m.from === currentRange.from && m.to === currentRange.to,
  );
  if (idx !== -1) {
    const prevIdx = (idx - 1 + matches.length) % matches.length;
    return { match: matches[prevIdx], index: prevIdx + 1 };
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (matches[i].to <= currentRange.from || matches[i].from < currentRange.from) {
      return { match: matches[i], index: i + 1 };
    }
  }
  return { match: matches[matches.length - 1], index: matches.length };
}
