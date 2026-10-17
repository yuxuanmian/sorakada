import { findClusterBreak, type Line, type Text } from "@codemirror/state";

/**
 * Budget parameters for smart selection scanning.
 */
export const MAX_STRUCTURE_SPAN_CHARS = 20_000;
export const MAX_STRUCTURE_WINDOW_CHARS = 30_000;
export const DEFAULT_SHARED_STRUCTURE_BUDGET = 50_000;
export const LINE_WINDOW_RADIUS = 256;
export const MAX_WORD_EXPAND_CHARS = 256;
export const MAX_COMPOUND_SPAN_CHARS = 128;
export const MAX_PARAGRAPH_LOOK_LINES = 50;
export const MAX_BLANK_LINE_SCAN_LENGTH = 500;
export const MAX_CALL_EXPR_LOOKBEHIND = 200;

export interface SmartSelectionScanBudget {
  structureCharsRemaining: number;
}

export type GraphemeCategory = "han" | "word" | "space" | "newline" | "punct";

export interface GraphemeCluster {
  readonly g: string;
  readonly from: number;
  readonly to: number;
  readonly category: GraphemeCategory;
}

export function categorizeGrapheme(g: string): GraphemeCategory {
  if (/^\p{Script=Han}+$/u.test(g)) {
    return "han";
  }
  // Include letters, digits, combining marks (\p{M}), and connector/underscore
  if (/^[\p{L}\p{N}\p{M}_]+$/u.test(g)) {
    return "word";
  }
  if (/^[^\S\r\n]+$/u.test(g)) {
    return "space";
  }
  if (/^[\r\n]+$/u.test(g)) {
    return "newline";
  }
  return "punct";
}

/**
 * Splits a text window into grapheme clusters with exact UTF-16 code unit offsets.
 * Uses Intl.Segmenter when available; falls back to CodeMirror's findClusterBreak.
 */
export function splitIntoGraphemes(
  text: string,
  baseOffset: number,
): GraphemeCluster[] {
  const result: GraphemeCluster[] = [];
  const intlAny = typeof Intl !== "undefined" ? (Intl as any) : undefined;
  if (intlAny && typeof intlAny.Segmenter === "function") {
    const segmenter = new intlAny.Segmenter(undefined, { granularity: "grapheme" });
    for (const seg of segmenter.segment(text)) {
      const g = seg.segment as string;
      const from = baseOffset + (seg.index as number);
      const to = from + g.length;
      result.push({ g, from, to, category: categorizeGrapheme(g) });
    }
  } else {
    let pos = 0;
    while (pos < text.length) {
      const next = findClusterBreak(text, pos, true);
      const end = next > pos ? next : pos + 1;
      const g = text.slice(pos, end);
      const from = baseOffset + pos;
      const to = baseOffset + end;
      result.push({ g, from, to, category: categorizeGrapheme(g) });
      pos = end;
    }
  }
  return result;
}

export interface Token {
  readonly from: number;
  readonly to: number;
  readonly type: GraphemeCategory;
}

export function groupTokens(clusters: readonly GraphemeCluster[]): Token[] {
  const tokens: Token[] = [];
  let current: { from: number; to: number; type: GraphemeCategory } | null = null;

  for (const c of clusters) {
    if (!current) {
      current = { from: c.from, to: c.to, type: c.category };
      continue;
    }

    const canMerge =
      current.type === c.category &&
      (c.category === "word" || c.category === "space" || c.category === "han");

    if (canMerge) {
      current.to = c.to;
    } else {
      tokens.push(current);
      current = { from: c.from, to: c.to, type: c.category };
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export interface TextRange {
  from: number;
  to: number;
  anchor: number;
  head: number;
}

function expandTokenIfTruncated(
  doc: Text,
  line: Line,
  token: Token,
  wStart: number,
  wEnd: number,
): TextRange {
  let from = token.from;
  let to = token.to;

  const isWordLike =
    token.type === "word" || token.type === "space" || token.type === "han";

  let startHitBoundary = false;
  if (from === wStart && wStart > line.from && isWordLike) {
    const checkStart = Math.max(line.from, from - MAX_WORD_EXPAND_CHARS);
    const prevText = doc.sliceString(checkStart, from);
    const prevClusters = splitIntoGraphemes(prevText, checkStart);
    let reachedBoundary = false;
    for (let i = prevClusters.length - 1; i >= 0; i--) {
      if (prevClusters[i].category === token.type) {
        from = prevClusters[i].from;
      } else {
        reachedBoundary = true;
        break;
      }
    }
    if (!reachedBoundary && checkStart > line.from) {
      startHitBoundary = true;
    }
  }

  let endHitBoundary = false;
  if (to === wEnd && wEnd < line.to && isWordLike) {
    const checkEnd = Math.min(line.to, to + MAX_WORD_EXPAND_CHARS);
    const nextText = doc.sliceString(to, checkEnd);
    const nextClusters = splitIntoGraphemes(nextText, to);
    let reachedBoundary = false;
    for (let i = 0; i < nextClusters.length; i++) {
      if (nextClusters[i].category === token.type) {
        to = nextClusters[i].to;
      } else {
        reachedBoundary = true;
        break;
      }
    }
    if (!reachedBoundary && checkEnd < line.to) {
      endHitBoundary = true;
    }
  }

  // If the unit exceeded the boundary budget without confirming word boundaries,
  // conservatively fall back to the line rather than returning a partial fragment.
  if (startHitBoundary || endHitBoundary) {
    return { from: line.from, to: line.to, anchor: line.from, head: line.to };
  }

  return { from, to, anchor: from, head: to };
}

/**
 * Returns the word or atomic unit range around `pos`.
 *
 * Honors mouse `bias` / `assoc`:
 * - `bias < 0`: Clicked in right half of character before `pos`, hits `pos - 1`.
 * - `bias > 0`: Clicked in left half of character at `pos`, hits `pos`.
 * - `bias === 0`: Keyboard caret at insertion point, stable insertion point rule.
 */
export function getWordOrUnitRange(
  doc: Text,
  pos: number,
  bias: number = 0,
): TextRange {
  const clampedPos = Math.max(0, Math.min(doc.length, pos));
  const line = doc.lineAt(clampedPos);

  if (line.length === 0) {
    const to = line.to < doc.length ? line.to + 1 : line.to;
    return { from: line.from, to, anchor: line.from, head: to };
  }

  let wStart = Math.max(line.from, clampedPos - LINE_WINDOW_RADIUS);
  let wEnd = Math.min(line.to, clampedPos + LINE_WINDOW_RADIUS);

  // Avoid slicing across a UTF-16 surrogate pair
  if (wStart > line.from) {
    const check = doc.sliceString(wStart - 1, wStart + 1);
    if (
      check.length === 2 &&
      check.charCodeAt(0) >= 0xd800 &&
      check.charCodeAt(0) <= 0xdbff &&
      check.charCodeAt(1) >= 0xdc00 &&
      check.charCodeAt(1) <= 0xdfff
    ) {
      wStart--;
    }
  }
  if (wEnd < line.to) {
    const check = doc.sliceString(wEnd - 1, wEnd + 1);
    if (
      check.length === 2 &&
      check.charCodeAt(0) >= 0xd800 &&
      check.charCodeAt(0) <= 0xdbff &&
      check.charCodeAt(1) >= 0xdc00 &&
      check.charCodeAt(1) <= 0xdfff
    ) {
      wEnd++;
    }
  }

  const clusters = splitIntoGraphemes(doc.sliceString(wStart, wEnd), wStart);
  const tokens = groupTokens(clusters);

  if (tokens.length === 0) {
    return { from: clampedPos, to: clampedPos, anchor: clampedPos, head: clampedPos };
  }

  // Mouse assoc handling
  if (bias < 0) {
    const targetPos = clampedPos > line.from ? clampedPos - 1 : line.from;
    for (const t of tokens) {
      if (t.from <= targetPos && targetPos < t.to) {
        return expandTokenIfTruncated(doc, line, t, wStart, wEnd);
      }
    }
  } else if (bias > 0) {
    const targetPos =
      clampedPos < line.to ? clampedPos : Math.max(line.from, line.to - 1);
    for (const t of tokens) {
      if (t.from <= targetPos && targetPos < t.to) {
        return expandTokenIfTruncated(doc, line, t, wStart, wEnd);
      }
    }
  }

  // Keyboard caret (bias === 0): stable insertion point rule
  const targetPos =
    clampedPos < line.to ? clampedPos : Math.max(line.from, line.to - 1);
  for (const t of tokens) {
    if (t.from <= targetPos && targetPos < t.to) {
      return expandTokenIfTruncated(doc, line, t, wStart, wEnd);
    }
  }

  return { from: clampedPos, to: clampedPos, anchor: clampedPos, head: clampedPos };
}

function findCallExpressionStart(doc: Text, openParenPos: number): number | null {
  const line = doc.lineAt(openParenPos);
  const minPos = Math.max(line.from, openParenPos - MAX_CALL_EXPR_LOOKBEHIND);
  let p = openParenPos;
  while (p > minPos) {
    const ch = doc.sliceString(p - 1, p);
    if (ch === " " || ch === "\t") {
      p--;
    } else {
      break;
    }
  }
  if (p <= minPos) {
    return null;
  }
  let idStart = p;
  while (idStart > minPos) {
    const ch = doc.sliceString(idStart - 1, idStart);
    if (/[\p{L}\p{N}_$]/u.test(ch)) {
      idStart--;
    } else {
      break;
    }
  }
  if (idStart < p) {
    return idStart;
  }
  return null;
}

const BRACKET_PAIRS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "）": "（",
  "】": "【",
  "》": "《",
};

const OPEN_BRACKETS = new Set(["(", "[", "{", "（", "【", "《"]);

function isBlankLine(line: Line): boolean {
  if (line.length === 0) {
    return true;
  }
  if (line.length > MAX_BLANK_LINE_SCAN_LENGTH) {
    return false;
  }
  return line.text.trim().length === 0;
}

/**
 * Computes the next semantically expanded range enclosing the given range.
 */
export function computeExpandedRange(
  doc: Text,
  range: { from: number; to: number },
  budget?: SmartSelectionScanBudget,
): TextRange {
  const { from, to } = range;

  // 1. Already full document -> no-op
  if (from === 0 && to === doc.length) {
    return { from: 0, to: doc.length, anchor: 0, head: doc.length };
  }

  // 2. Collapsed caret fast-path: directly returns unit range without structural/line scan
  if (from === to) {
    const unit = getWordOrUnitRange(doc, from, 0);
    if (unit.from < unit.to) {
      return unit;
    }
    return { from: 0, to: doc.length, anchor: 0, head: doc.length };
  }

  const candidates: { from: number; to: number }[] = [];

  const strictlyEnclosing = (cFrom: number, cTo: number) => {
    return (
      cFrom <= from &&
      cTo >= to &&
      (cFrom < from || cTo > to) &&
      0 <= cFrom &&
      cTo <= doc.length &&
      cFrom < cTo
    );
  };

  const addCandidate = (cFrom: number, cTo: number) => {
    if (strictlyEnclosing(cFrom, cTo)) {
      candidates.push({ from: cFrom, to: cTo });
    }
  };

  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);

  // 3. Partial selection within a single word:
  // If [from, to] is a sub-range inside a single word/unit (e.g. 'a' inside 'bar'),
  // add the enclosing unit as candidate.
  if (
    startLine.number === endLine.number &&
    to - from <= MAX_COMPOUND_SPAN_CHARS
  ) {
    const unitAtFrom = getWordOrUnitRange(doc, from, 0);
    addCandidate(unitAtFrom.from, unitAtFrom.to);
  }

  // 4. Compound candidates on single line (bounded range span)
  if (
    startLine.number === endLine.number &&
    to - from <= MAX_COMPOUND_SPAN_CHARS
  ) {
    const compStart = Math.max(startLine.from, from - 128);
    const compEnd = Math.min(startLine.to, to + 128);
    const localSlice = doc.sliceString(compStart, compEnd);

    // Dotted / hyphenated identifiers
    const idRegex = /(?:[\p{L}\p{N}_]+[.-])+[\p{L}\p{N}_]+/gu;
    let m: RegExpExecArray | null;
    while ((m = idRegex.exec(localSlice)) !== null) {
      addCandidate(compStart + m.index, compStart + m.index + m[0].length);
    }

    // Decimal numbers
    const numRegex = /\d+\.\d+/g;
    while ((m = numRegex.exec(localSlice)) !== null) {
      addCandidate(compStart + m.index, compStart + m.index + m[0].length);
    }
  }

  // 5. Structural Brackets & Quotes (bounded window and shared budget)
  if (to - from <= MAX_STRUCTURE_SPAN_CHARS) {
    const halfWindow = Math.floor(MAX_STRUCTURE_WINDOW_CHARS / 2);
    const windowStart = Math.max(0, from - halfWindow);
    const windowEnd = Math.min(doc.length, to + halfWindow);
    const sliceLength = windowEnd - windowStart;

    const canScanStructure =
      !budget || budget.structureCharsRemaining >= sliceLength;

    if (canScanStructure) {
      if (budget) {
        budget.structureCharsRemaining -= sliceLength;
      }

      const sliceText = doc.sliceString(windowStart, windowEnd);
      const stack: { char: string; pos: number }[] = [];
      let inString: string | null = null;
      let stringStart = 0;

      for (let i = 0; i < sliceText.length; i++) {
        const ch = sliceText[i];
        const absPos = windowStart + i;

        // Handle quotes / string literals
        if (inString !== null) {
          if (ch === "\\") {
            i++; // skip escaped char
            continue;
          }
          // Reset ASCII single/double quotes on newline to prevent swallowing subsequent lines
          if ((ch === "\n" || ch === "\r") && inString !== "`") {
            inString = null;
            continue;
          }
          if (ch === inString) {
            const qInnerFrom = stringStart + 1;
            const qInnerTo = absPos;
            const qOuterFrom = stringStart;
            const qOuterTo = absPos + 1;
            addCandidate(qInnerFrom, qInnerTo);
            addCandidate(qOuterFrom, qOuterTo);
            inString = null;
          }
          continue;
        }

        if (ch === '"' || ch === "'" || ch === "`") {
          inString = ch;
          stringStart = absPos;
          continue;
        }

        if (OPEN_BRACKETS.has(ch)) {
          stack.push({ char: ch, pos: absPos });
          continue;
        }

        const matchingOpen = BRACKET_PAIRS[ch];
        if (matchingOpen) {
          if (stack.length > 0 && stack[stack.length - 1].char === matchingOpen) {
            const openItem = stack.pop()!;
            const openPos = openItem.pos;
            const closePos = absPos + 1;

            // Inner bracket content
            const innerFrom = openPos + 1;
            const innerTo = closePos - 1;
            if (innerFrom < innerTo) {
              addCandidate(innerFrom, innerTo);
            }

            // Outer bracket content
            addCandidate(openPos, closePos);

            // Function call expression foo(...)
            if (openItem.char === "(" || openItem.char === "（") {
              const callStart = findCallExpressionStart(doc, openPos);
              if (callStart !== null) {
                addCandidate(callStart, closePos);
                if (
                  closePos < doc.length &&
                  doc.sliceString(closePos, closePos + 1) === ";"
                ) {
                  addCandidate(callStart, closePos + 1);
                }
              }
            }
          } else {
            // Conservative recovery: on mismatch, clear stack to prevent pseudo-pairing
            stack.length = 0;
          }
        }
      }
    }
  }

  // 6. Line candidates
  if (startLine.number === endLine.number) {
    if (startLine.length <= MAX_BLANK_LINE_SCAN_LENGTH) {
      const indentMatch = startLine.text.match(/^\s*/);
      const indentLen = indentMatch ? indentMatch[0].length : 0;
      const trailingMatch = startLine.text.match(/\s*$/);
      const trailingLen = trailingMatch ? trailingMatch[0].length : 0;

      const trimmedFrom = startLine.from + indentLen;
      const trimmedTo = startLine.to - trailingLen;
      if (trimmedFrom < trimmedTo) {
        addCandidate(trimmedFrom, trimmedTo);
      }
    }
    addCandidate(startLine.from, startLine.to);
    addCandidate(startLine.from, Math.min(doc.length, startLine.to + 1));
  } else {
    addCandidate(startLine.from, endLine.to);
    addCandidate(startLine.from, Math.min(doc.length, endLine.to + 1));
  }

  // 7. Paragraph candidate
  let paraStart = startLine.from;
  for (
    let l = startLine.number - 1, count = 0;
    l >= 1 && count < MAX_PARAGRAPH_LOOK_LINES;
    l--, count++
  ) {
    const line = doc.line(l);
    if (isBlankLine(line)) {
      paraStart = line.to + 1;
      break;
    }
    paraStart = line.from;
  }

  let paraEnd = endLine.to;
  for (
    let l = endLine.number + 1, count = 0;
    l <= doc.lines && count < MAX_PARAGRAPH_LOOK_LINES;
    l++, count++
  ) {
    const line = doc.line(l);
    if (isBlankLine(line)) {
      paraEnd = line.from;
      break;
    }
    paraEnd = line.to;
  }
  addCandidate(paraStart, paraEnd);

  // Document top
  addCandidate(0, doc.length);

  if (candidates.length === 0) {
    return { from: 0, to: doc.length, anchor: 0, head: doc.length };
  }

  // Sort by span length ascending; smallest strictly enclosing candidate is the next step
  candidates.sort((a, b) => {
    const spanA = a.to - a.from;
    const spanB = b.to - b.from;
    if (spanA !== spanB) {
      return spanA - spanB;
    }
    return b.from - a.from;
  });

  const next = candidates[0];
  return { from: next.from, to: next.to, anchor: next.from, head: next.to };
}