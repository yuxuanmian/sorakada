import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { addCursorAbove, addCursorBelow } from "@codemirror/commands";
import { emptyLineMouseSelectionStyle } from "./emptyLineSelection";
import {
  cancelColumnSelection,
  columnSelectionLifecyclePlugin,
  columnSelectionStyle,
  isAltShiftGesture,
  isColumnSelectionGesture,
} from "./columnSelection";
import { dragSelectionReset } from "./dragSelection";

export { cancelColumnSelection, isColumnSelectionGesture, isAltShiftGesture };

/**
 * Checks whether a given position falls within any range of the selection.
 */
export function isPosInSelection(sel: EditorSelection, pos: number): boolean {
  for (const r of sel.ranges) {
    if (r.from <= pos && r.to >= pos) {
      return true;
    }
  }
  return false;
}

/**
 * Removes the selection range surrounding `pos`, maintaining CodeMirror's
 * deterministic mainIndex adjustment policy. Returns `null` if no range matches
 * or if removing it would leave zero ranges.
 */
export function removeRangeAround(
  sel: EditorSelection,
  pos: number,
): EditorSelection | null {
  for (let i = 0; i < sel.ranges.length; i++) {
    const { from, to } = sel.ranges[i];
    if (from <= pos && to >= pos) {
      if (sel.ranges.length <= 1) {
        return null;
      }
      const newRanges = sel.ranges.slice(0, i).concat(sel.ranges.slice(i + 1));
      const newMainIndex =
        sel.mainIndex === i
          ? 0
          : sel.mainIndex - (sel.mainIndex > i ? 1 : 0);
      return EditorSelection.create(newRanges, newMainIndex);
    }
  }
  return null;
}

/**
 * Pure calculation for Alt+Shift mouse interaction.
 *
 * - Single click (`startPos === curPos`):
 *   - If clicking an existing range and `ranges.length > 1`: removes that range.
 *   - If clicking the only existing range: retains it (last cursor cannot be removed).
 *   - Otherwise: adds a new cursor at `curPos` and marks it as the main selection.
 * - Drag (`startPos !== curPos`):
 *   - Preserves existing ranges and adds a new continuous range from `startPos` to `curPos`
 *     as the main selection, allowing CodeMirror native normalization to merge overlaps.
 */
export function computeAltShiftSelection(
  startPos: number,
  curPos: number,
  startSel: EditorSelection,
): EditorSelection {
  if (startPos === curPos) {
    if (startSel.ranges.length > 1) {
      const removed = removeRangeAround(startSel, curPos);
      if (removed !== null) {
        return removed;
      }
    }
    if (startSel.ranges.length === 1 && isPosInSelection(startSel, curPos)) {
      return startSel;
    }
    return startSel.addRange(EditorSelection.cursor(curPos), true);
  }
  const newRange = EditorSelection.range(startPos, curPos);
  return startSel.addRange(newRange, true);
}

/**
 * Custom mouse selection style providing Alt+Shift click/drag multi-selection gestures.
 * Registered with Prec.highest so it intercepts Alt+Shift before CodeMirror's
 * built-in rectangularSelection (which captures any Alt+drag).
 */
export function multiCursorMouseStyle(): Extension {
  return Prec.highest(
    EditorView.mouseSelectionStyle.of((view, event) => {
      if (isColumnSelectionGesture(event)) {
        return columnSelectionStyle(view, event);
      }

      if (!isAltShiftGesture(event)) {
        return null;
      }

      const coords = view.posAndSideAtCoords(
        { x: event.clientX, y: event.clientY },
        false,
      );
      if (!coords) {
        return null;
      }

      let startPos = coords.pos;
      let startSel = view.state.selection;

      return {
        update(update: ViewUpdate) {
          if (update.docChanged) {
            startPos = update.changes.mapPos(startPos);
            startSel = startSel.map(update.changes);
          }
        },
        get(curEvent: MouseEvent) {
          const curCoords = view.posAndSideAtCoords(
            { x: curEvent.clientX, y: curEvent.clientY },
            false,
          );
          if (!curCoords) {
            return startSel;
          }
          return computeAltShiftSelection(startPos, curCoords.pos, startSel);
        },
      };
    }),
  );
}

/**
 * Explicit keymap for adding cursors above and below.
 */
export const multiCursorKeymap = keymap.of([
  { key: "Ctrl-Alt-ArrowUp", run: addCursorAbove },
  { key: "Ctrl-Alt-ArrowDown", run: addCursorBelow },
]);

/**
 * Combined extension for multi-cursor mouse gestures and navigation keymaps.
 */
export function multiCursorMouse(): Extension {
  return [
    multiCursorMouseStyle(),
    emptyLineMouseSelectionStyle(),
    multiCursorKeymap,
    columnSelectionLifecyclePlugin,
    dragSelectionReset(),
  ];
}
