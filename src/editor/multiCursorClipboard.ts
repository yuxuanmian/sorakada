import { EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const CLIP_MIME = "application/x-sorakada-clip";

export interface SegmentedClipboardPayload {
  id: string;
  text: string;
  segments: string[];
  linewise: boolean;
}

const CLIP_CACHE_LIMIT = 10;
const clipCache = new Map<string, SegmentedClipboardPayload>();

export function storeClip(payload: SegmentedClipboardPayload): void {
  if (clipCache.size >= CLIP_CACHE_LIMIT) {
    const oldestKey = clipCache.keys().next().value;
    if (oldestKey !== undefined) {
      clipCache.delete(oldestKey);
    }
  }
  clipCache.set(payload.id, payload);
}

export function getClip(id: string): SegmentedClipboardPayload | null {
  const item = clipCache.get(id);
  return item
    ? {
        id: item.id,
        text: item.text,
        segments: item.segments,
        linewise: item.linewise,
      }
    : null;
}

export function clearClipCache(): void {
  clipCache.clear();
}

/**
 * Extracts copy ranges and segments from the current editor state.
 *
 * - When non-empty ranges exist: copies ONLY non-empty ranges, in document order.
 * - When all ranges are empty: performs line-wise copy across unique lines.
 */
export function extractCopyRanges(state: EditorState): {
  segments: string[];
  fullText: string;
  cutRanges: { from: number; to: number }[];
  linewise: boolean;
} {
  const content: string[] = [];
  const cutRanges: { from: number; to: number }[] = [];
  let linewise = false;

  for (const range of state.selection.ranges) {
    if (!range.empty) {
      content.push(state.sliceDoc(range.from, range.to));
      cutRanges.push({ from: range.from, to: range.to });
    }
  }

  if (content.length === 0) {
    let upto = -1;
    for (const range of state.selection.ranges) {
      const line = state.doc.lineAt(range.from);
      if (line.number > upto) {
        content.push(line.text);
        cutRanges.push({
          from: line.from,
          to: Math.min(state.doc.length, line.to + 1),
        });
        upto = line.number;
      }
    }
    linewise = true;
  }

  const fullText = content.join(state.lineBreak);
  return {
    segments: content,
    fullText,
    cutRanges,
    linewise,
  };
}

/**
 * Determines replacement strings for each target selection based on spec §3.
 */
export function computePasteReplacements(
  segments: string[] | null,
  plainText: string,
  targetCount: number,
  lineBreak = "\n",
): string[] {
  if (segments !== null) {
    const M = segments.length;
    if (M === targetCount && targetCount > 1) {
      // Segment count equals target count (1-to-1 sequential mapping)
      return [...segments];
    }
    if (M === 1 && targetCount > 1) {
      // Single segment pasted into multiple targets
      return Array(targetCount).fill(segments[0]);
    }
    if (M > 1 && targetCount === 1) {
      // Multiple segments pasted into a single target
      return [segments.join(lineBreak)];
    }
    if (M > 1 && targetCount > 1 && M !== targetCount) {
      // Mismatched segment count: full joined text to each target
      return Array(targetCount).fill(segments.join(lineBreak));
    }
    // M === 1 && targetCount === 1
    return [...segments];
  }

  // External plain text or segment info unavailable:
  // CM convention: if line count equals target count, distribute line by line
  const lines = plainText.split(/\r\n|\r|\n/);
  if (lines.length === targetCount && targetCount > 1) {
    return lines;
  }
  return Array(targetCount).fill(plainText);
}

export function handleCopyOrCut(
  event: ClipboardEvent,
  view: EditorView,
  isCut: boolean,
): boolean {
  if (!event.clipboardData) {
    return false;
  }

  const { segments, fullText, cutRanges, linewise } = extractCopyRanges(view.state);
  if (!fullText && !linewise) {
    return false;
  }

  try {
    event.clipboardData.clearData();
    event.clipboardData.setData("text/plain", fullText);
  } catch {
    return false;
  }

  const clipId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload: SegmentedClipboardPayload = {
    id: clipId,
    text: fullText,
    segments,
    linewise,
  };
  storeClip(payload);

  try {
    event.clipboardData.setData(CLIP_MIME, JSON.stringify({ id: clipId }));
  } catch {
    // Ignore if browser restricts custom MIME
  }

  if (isCut && !view.state.readOnly) {
    view.dispatch({
      changes: cutRanges,
      scrollIntoView: true,
      userEvent: "delete.cut",
    });
  }

  return true;
}

export function handlePaste(event: ClipboardEvent, view: EditorView): boolean {
  if (view.state.readOnly) {
    return true;
  }

  if (!event.clipboardData) {
    return false;
  }

  const plainText = event.clipboardData.getData("text/plain") ?? "";

  let segments: string[] | null = null;
  let linewise = false;

  const rawMeta = event.clipboardData.getData(CLIP_MIME);
  if (rawMeta) {
    try {
      const parsed = JSON.parse(rawMeta);
      if (parsed && typeof parsed.id === "string") {
        const cached = getClip(parsed.id);
        if (cached && cached.text === plainText) {
          segments = cached.segments;
          linewise = cached.linewise;
        }
      }
    } catch {
      // Malformed metadata -> ignore
    }
  }

  if (!plainText && !linewise) {
    return false;
  }

  const { state } = view;
  const targets = state.selection.ranges;
  const targetCount = targets.length;

  // Linewise paste into all-empty selections:
  if (linewise && targets.every((r) => r.empty)) {
    let lastLine = -1;
    let lineIdx = 0;
    const byLine = segments !== null && segments.length === targetCount;
    const changes = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      if (line.from === lastLine) {
        return { range };
      }
      lastLine = line.from;
      const insertStr =
        (byLine ? segments![lineIdx++] : plainText) + state.lineBreak;
      const insert = state.toText(insertStr);
      return {
        changes: { from: line.from, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    });
    view.dispatch({
      ...changes,
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    return true;
  }

  const replacementTexts = computePasteReplacements(
    segments,
    plainText,
    targetCount,
    state.lineBreak,
  );

  let idx = 0;
  const changes = state.changeByRange((range) => {
    const textToInsert = replacementTexts[idx++];
    const insert = state.toText(textToInsert);
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });

  view.dispatch({
    ...changes,
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  return true;
}

/**
 * Custom clipboard extension implementing segmented multi-selection copy/cut/paste.
 */
export function multiCursorClipboard(): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      copy(event, view) {
        return handleCopyOrCut(event, view, false);
      },
      cut(event, view) {
        return handleCopyOrCut(event, view, true);
      },
      paste(event, view) {
        return handlePaste(event, view);
      },
    }),
  );
}
