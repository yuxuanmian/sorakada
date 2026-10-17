import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  computeExpandedRange,
  DEFAULT_SHARED_STRUCTURE_BUDGET,
  getWordOrUnitRange,
  type SmartSelectionScanBudget,
} from "./smartSelectionBoundaries";

export interface SelectionSnapshot {
  readonly ranges: readonly { readonly anchor: number; readonly head: number }[];
  readonly mainIndex: number;
}

export const MAX_HISTORY_STEPS = 64;

/**
 * StateEffect used to explicitly clear the smart selection expansion history
 * (e.g. when switching active documents or reloading).
 */
export const clearSmartSelectionHistory = StateEffect.define<void>();

export const smartSelectionActionEffect = StateEffect.define<
  | { readonly type: "expand"; readonly snapshot: SelectionSnapshot }
  | { readonly type: "shrink" }
>();

export const smartSelectionHistoryField = StateField.define<readonly SelectionSnapshot[]>({
  create() {
    return [];
  },
  update(history, tr) {
    // 1. Text edits (including undo/redo) invalidate smart selection history
    if (tr.docChanged) {
      return [];
    }

    // 2. Explicit clear effect (e.g. document switch or reload)
    for (const e of tr.effects) {
      if (e.is(clearSmartSelectionHistory)) {
        return [];
      }
    }

    // 3. Smart selection expand / shrink action
    let action:
      | { readonly type: "expand"; readonly snapshot: SelectionSnapshot }
      | { readonly type: "shrink" }
      | undefined;

    for (const e of tr.effects) {
      if (e.is(smartSelectionActionEffect)) {
        action = e.value;
        break;
      }
    }

    if (action) {
      if (action.type === "expand") {
        const next = [...history, action.snapshot];
        if (next.length > MAX_HISTORY_STEPS) {
          return next.slice(next.length - MAX_HISTORY_STEPS);
        }
        return next;
      }
      if (action.type === "shrink") {
        return history.slice(0, -1);
      }
    }

    // 4. Any external selection change (mouse click, arrow keys, search nav, select all, etc.)
    // invalidates smart selection history
    if (tr.selection !== undefined) {
      return [];
    }

    return history;
  },
});

export interface SmartSelectionTarget {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
}

export type SmartSelectionCommand = {
  (target: EditorView): boolean;
  (target: SmartSelectionTarget): boolean;
};

/**
 * Expands the selection to the next semantic structural unit.
 */
export const expandSmartSelection: SmartSelectionCommand = (
  target: EditorView | SmartSelectionTarget,
): boolean => {
  if (!target || !target.state) {
    return false;
  }
  const { state, dispatch } = target;
  const currentSel = state.selection;
  const doc = state.doc;

  const snapshot: SelectionSnapshot = {
    ranges: currentSel.ranges.map((r) => ({ anchor: r.anchor, head: r.head })),
    mainIndex: currentSel.mainIndex,
  };

  const scanBudget: SmartSelectionScanBudget = {
    structureCharsRemaining: DEFAULT_SHARED_STRUCTURE_BUDGET,
  };

  const newRanges: SelectionRange[] = [];
  for (const r of currentSel.ranges) {
    const expanded = computeExpandedRange(doc, r, scanBudget);
    const isBackward = r.head < r.anchor;
    const anchor = isBackward ? expanded.to : expanded.from;
    const head = isBackward ? expanded.from : expanded.to;
    newRanges.push(EditorSelection.range(anchor, head));
  }

  const newSel = EditorSelection.create(newRanges, currentSel.mainIndex);
  if (newSel.eq(currentSel)) {
    return false;
  }

  dispatch(
    state.update({
      selection: newSel,
      effects: smartSelectionActionEffect.of({
        type: "expand",
        snapshot,
      }),
      userEvent: "select.expand",
      scrollIntoView: true,
    }),
  );

  return true;
};

/**
 * Shrinks the selection to the previous snapshot before the last expand.
 */
export const shrinkSmartSelection: SmartSelectionCommand = (
  target: EditorView | SmartSelectionTarget,
): boolean => {
  if (!target || !target.state) {
    return false;
  }
  const { state, dispatch } = target;
  const history = state.field(smartSelectionHistoryField, false);
  if (!history || history.length === 0) {
    return false;
  }

  const snapshot = history[history.length - 1];
  const restoredRanges = snapshot.ranges.map((r) =>
    EditorSelection.range(r.anchor, r.head),
  );
  const restoredSel = EditorSelection.create(restoredRanges, snapshot.mainIndex);

  dispatch(
    state.update({
      selection: restoredSel,
      effects: smartSelectionActionEffect.of({
        type: "shrink",
      }),
      userEvent: "select.shrink",
      scrollIntoView: true,
    }),
  );

  return true;
};

/**
 * Custom mouse selection style that shares word/unit boundaries with smart selection.
 */
export function doubleClickMouseSelectionStyle(): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.detail !== 2 || event.altKey) {
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
    let startAssoc = coords.assoc;
    let startSel = view.state.selection;
    let startRange = getWordOrUnitRange(view.state.doc, startPos, startAssoc);

    return {
      update(update: ViewUpdate) {
        if (update.docChanged) {
          startPos = update.changes.mapPos(startPos);
          startSel = startSel.map(update.changes);
          startRange = getWordOrUnitRange(update.state.doc, startPos, startAssoc);
        }
      },
      get(curEvent: MouseEvent, extend: boolean, multiple: boolean) {
        const curCoords = view.posAndSideAtCoords(
          { x: curEvent.clientX, y: curEvent.clientY },
          false,
        );
        if (!curCoords) {
          return startSel;
        }

        const curRange = getWordOrUnitRange(
          view.state.doc,
          curCoords.pos,
          curCoords.assoc,
        );

        let range: SelectionRange;
        if (startPos !== curCoords.pos && !extend) {
          const from = Math.min(startRange.from, curRange.from);
          const to = Math.max(startRange.to, curRange.to);
          range =
            curCoords.pos < startPos
              ? EditorSelection.range(to, from)
              : EditorSelection.range(from, to);
        } else {
          range = EditorSelection.range(curRange.from, curRange.to);
        }

        if (extend) {
          return startSel.replaceRange(
            startSel.main.extend(range.from, range.to),
          );
        } else if (multiple) {
          return startSel.addRange(range);
        } else {
          return EditorSelection.single(range.anchor, range.head);
        }
      },
    };
  });
}

/**
 * Returns the smart selection extension bundle containing the history field
 * and the shared word boundary double-click selection style.
 */
export function smartSelection(): Extension {
  return [smartSelectionHistoryField, doubleClickMouseSelectionStyle()];
}