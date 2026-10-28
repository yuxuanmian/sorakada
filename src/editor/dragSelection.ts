import {
  EditorSelection,
  findClusterBreak,
  Prec,
  type Extension,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Determines whether a mouse event falls within the primary selection's actual text bounds.
 *
 * Requirements & Constraints:
 * - Half-open interval [from, to): pos `to` is exclusive and unselected.
 * - Respects character layout bounds via CodeMirror's public coordsForChar (so clicks
 *   in empty space or outside character bounds do not falsely hit the selection).
 * - Real newline characters are not draggable visual text glyphs; coordsForChar returns null
 *   for linebreaks, and clicking past the end of the line must not hit the newline.
 * - When coordsForChar returns null, do not assume a draggable glyph or invent fake geometry.
 * - Handles grapheme clusters (e.g. emoji surrogate pairs) using CodeMirror's findClusterBreak.
 * - Does not expand hit test for visual-only padding (such as the 5px newline marker).
 * - Only single left-clicks without modifier keys participate in drag-and-drop.
 */
export function isClickInPrimarySelection(
  view: EditorView,
  event: MouseEvent,
): boolean {
  if (event.button !== 0 || event.detail > 1) {
    return false;
  }
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }

  // Early return if click target is outside view.contentDOM (e.g. gutter, scrollbar, external elements).
  // Avoid Node instanceof checks to remain safe across window/iframe boundaries.
  const target = event.target as { nodeType?: number } | null;
  if (
    view.contentDOM &&
    target &&
    typeof (view.contentDOM as any).contains === "function"
  ) {
    try {
      if (!(view.contentDOM as any).contains(target)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const { main } = view.state.selection;
  if (main.empty) {
    return false;
  }

  const hit = view.posAndSideAtCoords(
    { x: event.clientX, y: event.clientY },
    false,
  );
  if (!hit) {
    return false;
  }

  let charPos: number;
  const line = view.state.doc.lineAt(hit.pos);
  const inLine = hit.pos - line.from;

  if (hit.assoc < 0) {
    if (inLine <= 0) {
      return false;
    }
    const clusterStart = findClusterBreak(line.text, inLine, false);
    charPos = line.from + clusterStart;
  } else {
    charPos = hit.pos;
  }

  if (charPos < 0 || charPos >= view.state.doc.length) {
    return false;
  }

  const charInLine = charPos - line.from;
  if (charInLine < 0 || charInLine >= line.length) {
    return false;
  }
  const clusterEnd = line.from + findClusterBreak(line.text, charInLine, true);

  // Half-open interval [from, to): entire cluster must fall within [main.from, main.to)
  if (charPos < main.from || clusterEnd > main.to) {
    return false;
  }

  // Retrieve the exact character glyph bounding box via CodeMirror's public coordsForChar.
  // For line breaks (newlines), unrendered text, or non-glyph positions, coordsForChar returns null.
  // If null, do not assume a draggable glyph or invent fallback geometry.
  if (typeof view.coordsForChar !== "function") {
    return false;
  }
  const rect = view.coordsForChar(charPos);
  if (!rect) {
    return false;
  }

  // Subpixel tolerance bridging high-DPI scaling (up to 1.5px)
  const padX = 1.5;
  const padY = 1.5;

  return (
    event.clientX >= rect.left - padX &&
    event.clientX <= rect.right + padX &&
    event.clientY >= rect.top - padY &&
    event.clientY <= rect.bottom + padY
  );
}

/**
 * Handles mousedown by resetting selection to clicked position if clicking outside
 * the existing primary selection.
 *
 * Returns false so that standard CodeMirror mouse selection handling can follow.
 */
export function handleDragSelectionMousedown(
  event: MouseEvent,
  view: EditorView,
): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.detail > 1 ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return false;
  }

  // Top-level early return if click target is outside view.contentDOM (e.g. gutter, scrollbar, external elements).
  // Avoid Node instanceof checks to remain safe across window/iframe boundaries.
  const target = event.target as { nodeType?: number } | null;
  if (
    !view.contentDOM ||
    !target ||
    typeof (view.contentDOM as any).contains !== "function"
  ) {
    return false;
  }
  try {
    if (!(view.contentDOM as any).contains(target)) {
      return false;
    }
  } catch {
    return false;
  }

  const { main } = view.state.selection;
  if (main.empty) {
    return false;
  }

  if (!isClickInPrimarySelection(view, event)) {
    const hit = view.posAndSideAtCoords(
      { x: event.clientX, y: event.clientY },
      false,
    );
    if (hit) {
      view.dispatch({
        selection: EditorSelection.cursor(hit.pos, hit.assoc),
        userEvent: "select.pointer",
      });
    }
  }
  return false;
}

/**
 * Resets existing selection on mousedown when clicking outside the primary selection.
 *
 * Native CodeMirror's `isInPrimarySelection` checks DOM Range client rectangles directly
 * without checking document position bounds, and returns `true` when DOM rangeCount is 0
 * or when the DOM range encompasses the line container. This causes MouseSelection to set
 * `dragging = null`, preventing normal drag-selection and incorrectly triggering drag-and-drop
 * of the old selection.
 *
 * This handler intercepts mousedown with highest precedence:
 * - If the click is outside the primary selection, it collapses the selection to the click position.
 * - When CodeMirror's internal mousedown handler then runs, `main.empty` is true, so `isInPrimarySelection`
 *   returns false (`dragging = false`), immediately starting a fresh mouse selection drag.
 * - If the click is inside the primary selection, the selection is untouched, preserving native drag-and-drop.
 */
export function dragSelectionReset(): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      mousedown: handleDragSelectionMousedown,
    }),
  );
}