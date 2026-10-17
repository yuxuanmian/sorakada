import {
  EditorSelection,
  EditorState,
  StateEffect,
  type SelectionRange,
} from "@codemirror/state";
import {
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
/**
 * Matches the new 013 column selection gesture: Ctrl+Shift+Alt+Left.
 * Requires exact modifier combo and does not accept Meta.
 */
export function isColumnSelectionGesture(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    event.ctrlKey &&
    event.altKey &&
    event.shiftKey &&
    !event.metaKey
  );
}

/**
 * Matches the legacy Alt+Shift gesture without Ctrl/Meta.
 */
export function isAltShiftGesture(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

/**
 * Representation of a single visual line (either an unwrapped logical line,
 * or one wrapped segment of a soft-wrapped logical line).
 */
export interface VisualLine {
  from: number;
  to: number;
  y: number;
}

/**
 * Structural view interface required by column selection calculations,
 * matching native CodeMirror 6 EditorView API signatures.
 */
export interface ColumnSelectionView {
  state: EditorState;
  lineBlockAtHeight(height: number): {
    from: number;
    to: number;
    top: number;
    bottom: number;
    height: number;
  };
  lineBlockAt(pos: number): {
    from: number;
    to: number;
    top: number;
    bottom: number;
    height: number;
  };
  coordsAtPos(
    pos: number,
    side?: -1 | 1,
  ): { top: number; bottom: number; left: number; right: number } | null;
  posAtCoords(
    coords: { x: number; y: number },
    precise?: boolean,
  ): number | null;
  posAndSideAtCoords(
    coords: { x: number; y: number },
    precise?: boolean,
  ): { pos: number; assoc: 1 | -1 } | null;
  moveToLineBoundary(
    range: SelectionRange,
    forward: boolean,
    includeWrap?: boolean,
  ): SelectionRange;
  documentTop: number;
  contentHeight?: number;
  lineWrapping?: boolean;
  defaultLineHeight?: number;
  contentDOM?: HTMLElement;
  win?: Window | null;
}

/**
 * Resolves screen coordinates {x, y} to a document offset using native CM APIs.
 */
export function getPosAtCoords(
  view: ColumnSelectionView,
  coords: { x: number; y: number },
): number | null {
  const res = view.posAtCoords(coords, false);
  if (typeof res === "number") return res;
  const sideRes = view.posAndSideAtCoords(coords, false);
  if (sideRes && typeof sideRes.pos === "number") return sideRes.pos;
  return null;
}

export const MAX_COLUMN_VISUAL_LINES = 1000;

/**
 * Finds all visual lines intersecting the vertical interval [minY, maxY].
 * Uses real CM layout geometry (lineBlockAtHeight, coordsAtPos, moveToLineBoundary)
 * without uniform height guessing or unmeasured DOM scanning.
 */
export function getVisualLinesInRect(
  view: ColumnSelectionView,
  topY: number,
  bottomY: number,
  referenceX: number,
): VisualLine[] {
  const minY = Math.min(topY, bottomY);
  const maxY = Math.max(topY, bottomY);
  const docTop = view.documentTop;
  const contentHeight =
    typeof view.contentHeight === "number" ? view.contentHeight : Infinity;

  const startHeight = Math.max(0, Math.min(contentHeight, minY - docTop));
  const endHeight = Math.max(0, Math.min(contentHeight, maxY - docTop));

  const result: VisualLine[] = [];
  let outerBudget = MAX_COLUMN_VISUAL_LINES;

  let currHeight = startHeight;
  while (
    currHeight <= endHeight &&
    outerBudget > 0 &&
    result.length < MAX_COLUMN_VISUAL_LINES
  ) {
    outerBudget--;
    const block = view.lineBlockAtHeight(currHeight);
    const useWrapping =
      Boolean(view.lineWrapping) &&
      typeof view.moveToLineBoundary === "function";

    if (!useWrapping) {
      let midY: number;
      const coords =
        view.coordsAtPos(block.from, 1) || view.coordsAtPos(block.to, -1);
      if (coords) {
        midY = (coords.top + coords.bottom) / 2;
      } else {
        midY = docTop + (block.top + block.bottom) / 2;
      }

      result.push({ from: block.from, to: block.to, y: midY });
    } else {
      let startCursor: SelectionRange;
      const startPosAndSide = view.posAndSideAtCoords(
        { x: referenceX, y: minY },
        false,
      );

      if (
        startPosAndSide &&
        startPosAndSide.pos >= block.from &&
        startPosAndSide.pos <= block.to
      ) {
        startCursor = EditorSelection.cursor(
          startPosAndSide.pos,
          startPosAndSide.assoc,
        );
      } else {
        startCursor = EditorSelection.cursor(block.from, 1);
      }

      let segStart = Math.max(
        block.from,
        view.moveToLineBoundary(startCursor, false, true).head,
      );
      let segEnd = Math.min(
        block.to,
        view.moveToLineBoundary(startCursor, true, true).head,
      );

      let innerBudget = MAX_COLUMN_VISUAL_LINES;
      while (innerBudget > 0 && result.length < MAX_COLUMN_VISUAL_LINES) {
        innerBudget--;
        const coords =
          view.coordsAtPos(segStart, 1) || view.coordsAtPos(segEnd, -1);
        const midY = coords
          ? (coords.top + coords.bottom) / 2
          : docTop + (block.top + block.bottom) / 2;

        const lineTop = coords ? coords.top : minY;
        const lineBottom = coords ? coords.bottom : maxY;

        if (lineBottom >= minY && lineTop <= maxY) {
          result.push({ from: segStart, to: segEnd, y: midY });
        }

        // Reached or passed bottom of drag rectangle
        if (coords && coords.top > maxY) {
          break;
        }

        // Reached end of logical block
        if (segEnd >= block.to) {
          break;
        }

        const nextCursor = EditorSelection.cursor(segEnd, 1);
        const nextStart = Math.max(
          segEnd,
          view.moveToLineBoundary(nextCursor, false, true).head,
        );
        const nextEnd = Math.min(
          block.to,
          view.moveToLineBoundary(nextCursor, true, true).head,
        );

        if (nextStart === segStart && nextEnd === segEnd) {
          break;
        }

        segStart = nextStart;
        segEnd = nextEnd;
      }
    }

    const nextHeight = Math.max(currHeight + 0.01, block.bottom + 0.001);
    if (nextHeight <= currHeight) {
      break;
    }
    currHeight = nextHeight;
  }

  return result;
}

/**
 * Computes the selection range for a single visual line.
 *
 * Rules:
 * - Short lines clip to real line end.
 * - Empty lines clip to line start (no virtual spaces inserted).
 * - Visual line boundaries clip endpoints so wrapped line segments do not swallow the next segment.
 * - Zero-width horizontal drag produces a cursor.
 * - Horizontal span produces a range.
 */
export function computeColumnRangeForLine(
  view: ColumnSelectionView,
  line: VisualLine,
  startX: number,
  curX: number,
): SelectionRange {
  const rawStart = getPosAtCoords(view, { x: startX, y: line.y });
  const rawCur = getPosAtCoords(view, { x: curX, y: line.y });

  const startResolved =
    rawStart !== null ? rawStart : startX <= curX ? line.from : line.to;
  const curResolved =
    rawCur !== null ? rawCur : curX <= startX ? line.from : line.to;

  const startPos = Math.max(line.from, Math.min(line.to, startResolved));
  const curPos = Math.max(line.from, Math.min(line.to, curResolved));

  if (startX === curX || startPos === curPos) {
    return EditorSelection.cursor(curPos);
  }
  return EditorSelection.range(startPos, curPos);
}

/**
 * Pure calculation for additive column selection.
 *
 * Preserves all selection ranges from before the drag started (`startSel`),
 * appending the visual-line-by-line ranges generated by the current drag rectangle.
 * Foldback naturally recalculates against the new rectangle, discarding intermediate positions.
 * Newly added selection is preferred as the main selection.
 */
export function computeColumnSelection(
  view: ColumnSelectionView,
  startPoint: { x: number; y: number },
  curPoint: { x: number; y: number },
  startSel: EditorSelection,
): EditorSelection {
  const topY = Math.min(startPoint.y, curPoint.y);
  const bottomY = Math.max(startPoint.y, curPoint.y);
  const startX = startPoint.x;
  const curX = curPoint.x;

  const visualLines = getVisualLinesInRect(view, topY, bottomY, startX);
  if (visualLines.length === 0) {
    return startSel;
  }

  const columnRanges: SelectionRange[] = [];
  for (const vl of visualLines) {
    columnRanges.push(computeColumnRangeForLine(view, vl, startX, curX));
  }

  // Preferred primary range matches the line where the pointer currently is
  const primaryRange =
    curPoint.y >= startPoint.y
      ? columnRanges[columnRanges.length - 1]
      : columnRanges[0];

  const allRanges = [...startSel.ranges, ...columnRanges];
  const preferredIndex = allRanges.lastIndexOf(primaryRange);

  return EditorSelection.create(
    allRanges,
    preferredIndex >= 0 ? preferredIndex : 0,
  );
}

let activeSessionCancel: (() => void) | null = null;

/**
 * Explicit cancellation contract for column selection.
 * Allows Bridges / host tabs to terminate in-flight column selection on tab switch or document reload.
 */
export function cancelColumnSelection(): void {
  if (activeSessionCancel) {
    activeSessionCancel();
    activeSessionCancel = null;
  }
}

/**
 * ViewPlugin ensuring that view destruction or document reconfiguration
 * terminates any in-flight column selection cleanly.
 */
export const columnSelectionLifecyclePlugin = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (
        update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(StateEffect.reconfigure)),
        )
      ) {
        cancelColumnSelection();
      }
    }
    destroy() {
      cancelColumnSelection();
    }
  },
);

/**
 * Custom mouse selection style providing Ctrl+Shift+Alt additive visual-line rectangular drag.
 */
export function columnSelectionStyle(view: EditorView, event: MouseEvent) {
  cancelColumnSelection();

  let startSel = view.state.selection;
  const posAndSide = view.posAndSideAtCoords
    ? view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false)
    : null;
  const rawAnchorPos =
    posAndSide?.pos ??
    (view.posAtCoords
      ? view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
      : null);
  let anchorPos =
    rawAnchorPos !== null ? rawAnchorPos : view.state.doc.lineAt(0).from;
  const anchorAssoc = posAndSide?.assoc ?? (1 as 1 | -1);

  // Content-relative horizontal coordinate so horizontal auto-scroll preserves document column
  const contentRect = view.contentDOM?.getBoundingClientRect
    ? view.contentDOM.getBoundingClientRect()
    : null;
  const docOffsetX = contentRect
    ? event.clientX - contentRect.left
    : event.clientX;

  // Compute visual segment relative offset within lineBlock for offscreen fallback
  const initialBlock = view.lineBlockAt ? view.lineBlockAt(anchorPos) : null;
  const initialCoords = view.coordsAtPos
    ? view.coordsAtPos(anchorPos, anchorAssoc)
    : null;
  let anchorSegOffsetInBlock = 0;
  if (initialCoords && initialBlock) {
    const initialVisualY = (initialCoords.top + initialCoords.bottom) / 2;
    const blockTopScreen = (view.documentTop || 0) + initialBlock.top;
    anchorSegOffsetInBlock = initialVisualY - blockTopScreen;
  }
  let needsSegOffsetRefresh = false;

  let active = true;

  const win =
    (view as { win?: Window | null }).win ||
    view.contentDOM?.ownerDocument?.defaultView ||
    (typeof window !== "undefined" ? window : null);
  const doc =
    view.contentDOM?.ownerDocument ||
    (typeof document !== "undefined" ? document : null);

  const cleanupListeners = () => {
    if (win && typeof win.removeEventListener === "function") {
      win.removeEventListener("mouseup", onMouseUp, true);
      win.removeEventListener("keyup", onKeyUp, true);
      win.removeEventListener("blur", onBlur);
    }
    if (doc && typeof doc.removeEventListener === "function") {
      doc.removeEventListener("mouseup", onMouseUp, true);
      doc.removeEventListener("keydown", onKeyDown);
    }
    if (
      view.contentDOM &&
      typeof view.contentDOM.removeEventListener === "function"
    ) {
      view.contentDOM.removeEventListener("focusout", onBlur);
    }
    if (activeSessionCancel === cancelSession) {
      activeSessionCancel = null;
    }
  };

  const cancelSession = () => {
    if (!active) return;
    active = false;
    cleanupListeners();
  };

  const onMouseUp = () => {
    cancelSession();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!e.ctrlKey || !e.shiftKey || !e.altKey) {
      cancelSession();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      cancelSession();
    }
  };

  const onBlur = () => {
    cancelSession();
  };

  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("mouseup", onMouseUp, true);
    win.addEventListener("keyup", onKeyUp, true);
    win.addEventListener("blur", onBlur);
  }
  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("mouseup", onMouseUp, true);
    doc.addEventListener("keydown", onKeyDown);
  }
  if (
    view.contentDOM &&
    typeof view.contentDOM.addEventListener === "function"
  ) {
    view.contentDOM.addEventListener("focusout", onBlur);
  }

  activeSessionCancel = cancelSession;

  return {
    update(update: ViewUpdate) {
      if (!active) return;
      if (update.docChanged) {
        startSel = startSel.map(update.changes);
        anchorPos = update.changes.mapPos(anchorPos, anchorAssoc);
        needsSegOffsetRefresh = true;
      }
    },
    get(curEvent: MouseEvent) {
      if (!active) {
        return view.state.selection;
      }

      // If modifier keys were released during drag, terminate selection changes and freeze
      if (!isColumnSelectionGesture(curEvent)) {
        cancelSession();
        return view.state.selection;
      }

      // Re-acquire horizontal anchor X via current contentDOM rect
      const curContentRect = view.contentDOM?.getBoundingClientRect
        ? view.contentDOM.getBoundingClientRect()
        : null;
      const startX = curContentRect
        ? curContentRect.left + docOffsetX
        : event.clientX;

      // Re-acquire vertical anchor Y with assoc or offscreen fallback
      let anchorY: number;
      const coords = view.coordsAtPos
        ? view.coordsAtPos(anchorPos, anchorAssoc)
        : null;
      if (coords) {
        anchorY = (coords.top + coords.bottom) / 2;
        if (needsSegOffsetRefresh && view.lineBlockAt) {
          const curBlock = view.lineBlockAt(anchorPos);
          anchorSegOffsetInBlock =
            anchorY - ((view.documentTop || 0) + curBlock.top);
          needsSegOffsetRefresh = false;
        }
      } else if (view.lineBlockAt) {
        const block = view.lineBlockAt(anchorPos);
        anchorY = (view.documentTop || 0) + block.top + anchorSegOffsetInBlock;
      } else {
        anchorY = event.clientY;
      }

      return computeColumnSelection(
        view as unknown as ColumnSelectionView,
        { x: startX, y: anchorY },
        { x: curEvent.clientX, y: curEvent.clientY },
        startSel,
      );
    },
  };
}
