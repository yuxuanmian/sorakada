import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Direction } from "@codemirror/view";
import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineDown,
} from "@codemirror/commands";
import {
  computeAltShiftSelection,
  isPosInSelection,
  removeRangeAround,
} from "./multiCursorMouse";

describe("multiCursorMouse pure selection logic", () => {
  it("identifies whether a position is covered by a selection range or cursor", () => {
    const sel = EditorSelection.create([
      EditorSelection.cursor(5),
      EditorSelection.range(10, 15),
    ]);

    expect(isPosInSelection(sel, 5)).toBe(true);
    expect(isPosInSelection(sel, 4)).toBe(false);
    expect(isPosInSelection(sel, 10)).toBe(true);
    expect(isPosInSelection(sel, 12)).toBe(true);
    expect(isPosInSelection(sel, 15)).toBe(true);
    expect(isPosInSelection(sel, 16)).toBe(false);
  });

  it("removes an existing range when multiple ranges exist and adjusts mainIndex deterministically", () => {
    // Ranges at 5, 10, 20 with mainIndex = 2 (pos 20)
    const sel = EditorSelection.create(
      [
        EditorSelection.cursor(5),
        EditorSelection.cursor(10),
        EditorSelection.cursor(20),
      ],
      2,
    );

    // Remove middle cursor at 10: mainIndex was 2, now becomes 1
    const removed10 = removeRangeAround(sel, 10);
    expect(removed10).not.toBeNull();
    expect(removed10!.ranges.map((r) => r.from)).toEqual([5, 20]);
    expect(removed10!.mainIndex).toBe(1);

    // Remove main cursor at 20: mainIndex resets to 0 (CodeMirror deterministic policy)
    const removed20 = removeRangeAround(sel, 20);
    expect(removed20).not.toBeNull();
    expect(removed20!.ranges.map((r) => r.from)).toEqual([5, 10]);
    expect(removed20!.mainIndex).toBe(0);
  });

  it("refuses to remove the last remaining cursor", () => {
    const single = EditorSelection.single(10);
    expect(removeRangeAround(single, 10)).toBeNull();

    // computeAltShiftSelection preserves the only cursor when clicked on it
    const result = computeAltShiftSelection(10, 10, single);
    expect(result.ranges.length).toBe(1);
    expect(result.main.from).toBe(10);
  });

  it("adds a new cursor on click and makes it the main selection", () => {
    const initial = EditorSelection.single(5);

    // Add cursor at 15
    const added = computeAltShiftSelection(15, 15, initial);
    expect(added.ranges.map((r) => r.from)).toEqual([5, 15]);
    // Newly added cursor becomes the main selection
    expect(added.main.from).toBe(15);
    expect(added.mainIndex).toBe(1);

    // Add cursor at 0 (before existing)
    const addedBefore = computeAltShiftSelection(0, 0, added);
    expect(addedBefore.ranges.map((r) => r.from)).toEqual([0, 5, 15]);
    expect(addedBefore.main.from).toBe(0);
    expect(addedBefore.mainIndex).toBe(0);
  });

  it("removes a cursor on subsequent click when multiple cursors exist", () => {
    const twoCursors = EditorSelection.create([
      EditorSelection.cursor(5),
      EditorSelection.cursor(15),
    ]);

    // Click on 15 removes it, leaving only 5
    const afterRemoval = computeAltShiftSelection(15, 15, twoCursors);
    expect(afterRemoval.ranges.map((r) => r.from)).toEqual([5]);
    expect(afterRemoval.main.from).toBe(5);
  });

  it("adds an independent continuous range on drag and merges overlaps", () => {
    const initial = EditorSelection.single(2);

    // Drag from 10 to 20
    const dragged = computeAltShiftSelection(10, 20, initial);
    expect(dragged.ranges.length).toBe(2);
    expect(dragged.ranges[0].from).toBe(2);
    expect(dragged.ranges[0].to).toBe(2);
    expect(dragged.ranges[1].from).toBe(10);
    expect(dragged.ranges[1].to).toBe(20);
    expect(dragged.main.from).toBe(10);
    expect(dragged.main.to).toBe(20);

    // Dragging over existing range at 2 (e.g. from 1 to 5) merges them
    const merged = computeAltShiftSelection(1, 5, initial);
    expect(merged.ranges.length).toBe(1);
    expect(merged.ranges[0].from).toBe(1);
    expect(merged.ranges[0].to).toBe(5);
  });
});

describe("CodeMirror native multi-cursor arrow navigation & boundary merge", () => {
  it("merges 3 cursors into 2 when moving left and hitting document start boundary", () => {
    let state = EditorState.create({
      doc: "hello world",
      selection: EditorSelection.create([
        EditorSelection.cursor(0), // at boundary
        EditorSelection.cursor(1), // moves to 0 -> merges with cursor at 0
        EditorSelection.cursor(3), // moves to 2
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const mockView = {
      state,
      textDirectionAt: () => Direction.LTR,
      bidiSpans: () => [{ from: 0, to: 11, dir: Direction.LTR, level: 0 }],
      moveByChar: (range: { head: number }, forward: boolean) => {
        const next = forward
          ? Math.min(state.doc.length, range.head + 1)
          : Math.max(0, range.head - 1);
        return EditorSelection.cursor(next);
      },
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
        mockView.state = state;
      },
    };

    expect(state.selection.ranges.length).toBe(3);
    const handled = cursorCharLeft(mockView as never);
    expect(handled).toBe(true);
    // 3 cursors merged into 2
    expect(mockView.state.selection.ranges.length).toBe(2);
    expect(mockView.state.selection.ranges.map((r) => r.head)).toEqual([0, 2]);
  });

  it("merges 3 cursors into 2 when moving right and hitting document end boundary", () => {
    const doc = "hello"; // length 5
    let state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.cursor(2), // moves to 3
        EditorSelection.cursor(4), // moves to 5 -> merges with cursor at 5
        EditorSelection.cursor(5), // at boundary
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const mockView = {
      state,
      textDirectionAt: () => Direction.LTR,
      bidiSpans: () => [{ from: 0, to: 5, dir: Direction.LTR, level: 0 }],
      moveByChar: (range: { head: number }, forward: boolean) => {
        const next = forward
          ? Math.min(state.doc.length, range.head + 1)
          : Math.max(0, range.head - 1);
        return EditorSelection.cursor(next);
      },
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
        mockView.state = state;
      },
    };

    expect(state.selection.ranges.length).toBe(3);
    const handled = cursorCharRight(mockView as never);
    expect(handled).toBe(true);
    // 3 cursors merged into 2
    expect(mockView.state.selection.ranges.length).toBe(2);
    expect(mockView.state.selection.ranges.map((r) => r.head)).toEqual([3, 5]);
  });

  it("merges 3 cursors into 2 when moving vertically down into a shorter line", () => {
    // line 1: 0..10 ("0123456789")
    // line 2: 11..16 (len 5: "abcde")
    // line 3: 17..27 ("0123456789")
    const doc = "0123456789\nabcde\n0123456789";
    let state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.cursor(3), // col 3 on line 1 -> col 3 on line 2 (offset 14)
        EditorSelection.cursor(6), // col 6 on line 1 -> clamps to col 5 on line 2 (offset 16)
        EditorSelection.cursor(9), // col 9 on line 1 -> clamps to col 5 on line 2 (offset 16)
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const mockView = {
      state,
      moveVertically: (range: { head: number }, forward: boolean) => {
        const curLine = state.doc.lineAt(range.head);
        const targetLineNum = forward
          ? Math.min(state.doc.lines, curLine.number + 1)
          : Math.max(1, curLine.number - 1);
        const targetLine = state.doc.line(targetLineNum);
        const col = range.head - curLine.from;
        const clampedCol = Math.min(col, targetLine.length);
        return EditorSelection.cursor(targetLine.from + clampedCol);
      },
      moveToLineBoundary: (range: unknown) => range,
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
        mockView.state = state;
      },
    };

    expect(state.selection.ranges.length).toBe(3);
    const handled = cursorLineDown(mockView as never);
    expect(handled).toBe(true);
    // 3 cursors merged into 2 because col 6 and col 9 both clamped to the end of short line 2
    expect(mockView.state.selection.ranges.length).toBe(2);
    expect(mockView.state.selection.ranges.map((r) => r.head)).toEqual([14, 16]);
  });
});
