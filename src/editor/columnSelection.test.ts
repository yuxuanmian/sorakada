import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  cancelColumnSelection,
  columnSelectionStyle,
  computeColumnRangeForLine,
  computeColumnSelection,
  getVisualLinesInRect,
  MAX_COLUMN_VISUAL_LINES,
  type ColumnSelectionView,
  type VisualLine,
} from "./columnSelection";
import {
  isAltShiftGesture,
  isColumnSelectionGesture,
} from "./multiCursorMouse";

interface MockBlockConfig {
  from: number;
  to: number;
  top: number;
  bottom: number;
  height: number;
  segments?: Array<{
    from: number;
    to: number;
    top: number;
    bottom: number;
  }>;
}

/**
 * Builds a test view strictly implementing CodeMirror 6 production
 * EditorView geometry API contracts without DOM dependencies.
 */
function createProductionMockView(options: {
  state: EditorState;
  blocks: MockBlockConfig[];
  lineWrapping?: boolean;
  defaultLineHeight?: number;
  charWidth?: number;
  documentTop?: number;
}): ColumnSelectionView {
  const charWidth = options.charWidth || 10;
  const docTop = options.documentTop || 0;
  const defaultLineHeight = options.defaultLineHeight || 20;

  const findBlockAtHeight = (h: number): MockBlockConfig => {
    for (const b of options.blocks) {
      if (h >= b.top && h < b.bottom) return b;
    }
    return options.blocks[options.blocks.length - 1];
  };

  const findBlockAtPos = (pos: number): MockBlockConfig => {
    for (const b of options.blocks) {
      if (pos >= b.from && pos <= b.to) return b;
    }
    return options.blocks[options.blocks.length - 1];
  };

  return {
    state: options.state,
    lineWrapping: options.lineWrapping ?? false,
    defaultLineHeight,
    documentTop: docTop,
    contentHeight:
      options.blocks.length > 0
        ? options.blocks[options.blocks.length - 1].bottom
        : 0,

    lineBlockAtHeight(height: number) {
      return findBlockAtHeight(height);
    },

    lineBlockAt(pos: number) {
      return findBlockAtPos(pos);
    },

    coordsAtPos(pos: number, side?: -1 | 1) {
      const block = findBlockAtPos(pos);
      if (block.segments && block.segments.length > 0) {
        const assoc = side || 1;
        let matchSeg = block.segments[0];
        for (const seg of block.segments) {
          if (assoc < 0) {
            if (pos > seg.from && pos <= seg.to) {
              matchSeg = seg;
              break;
            }
          } else {
            if (pos >= seg.from && pos < seg.to) {
              matchSeg = seg;
              break;
            }
          }
          if (pos === seg.to) matchSeg = seg;
        }
        const left = 10 + (pos - matchSeg.from) * charWidth;
        return {
          top: docTop + matchSeg.top,
          bottom: docTop + matchSeg.bottom,
          left,
          right: left + charWidth,
        };
      }

      const left = 10 + (pos - block.from) * charWidth;
      return {
        top: docTop + block.top,
        bottom: docTop + block.bottom,
        left,
        right: left + charWidth,
      };
    },

    posAtCoords(coords: { x: number; y: number }) {
      const sideRes = this.posAndSideAtCoords(coords);
      return sideRes ? sideRes.pos : null;
    },

    posAndSideAtCoords(coords: { x: number; y: number }) {
      const h = coords.y - docTop;
      const block = findBlockAtHeight(h);
      if (block.segments && block.segments.length > 0) {
        let seg = block.segments[0];
        for (const s of block.segments) {
          if (h >= s.top && h < s.bottom) {
            seg = s;
            break;
          }
        }
        const relX = coords.x - 10;
        const col = Math.round(relX / charWidth);
        const len = seg.to - seg.from;
        if (col >= len) {
          // Past the end of this visual line segment
          return { pos: seg.to, assoc: -1 };
        }
        const offset = Math.max(0, col);
        return { pos: seg.from + offset, assoc: 1 };
      }

      const relX = coords.x - 10;
      const col = Math.round(relX / charWidth);
      const len = block.to - block.from;
      const offset = Math.max(0, Math.min(len, col));
      return { pos: block.from + offset, assoc: 1 };
    },

    moveToLineBoundary(cursor, forward, includeWrap) {
      const block = findBlockAtPos(cursor.head);
      if (includeWrap && block.segments && block.segments.length > 0) {
        const assoc = cursor.assoc || -1;
        let matchSeg = block.segments[0];
        for (const s of block.segments) {
          if (assoc < 0) {
            if (cursor.head > s.from && cursor.head <= s.to) {
              matchSeg = s;
              break;
            }
          } else {
            if (cursor.head >= s.from && cursor.head < s.to) {
              matchSeg = s;
              break;
            }
          }
          if (cursor.head === s.to) matchSeg = s;
        }
        return EditorSelection.cursor(
          forward ? matchSeg.to : matchSeg.from,
          forward ? -1 : 1,
        );
      }
      return EditorSelection.cursor(
        forward ? block.to : block.from,
        forward ? -1 : 1,
      );
    },
  };
}

describe("Column selection gesture dispatch", () => {
  it("exact matches Ctrl+Shift+Alt+Left without Meta, and gives it precedence over Alt+Shift", () => {
    const colEventCtrl = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
    } as MouseEvent;

    // Meta must NOT substitute Ctrl
    const colEventMeta = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: true,
    } as MouseEvent;

    // Extra Meta on top of Ctrl must also be rejected
    const colEventBoth = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: true,
    } as MouseEvent;

    const altShiftEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
    } as MouseEvent;

    expect(isColumnSelectionGesture(colEventCtrl)).toBe(true);
    expect(isColumnSelectionGesture(colEventMeta)).toBe(false);
    expect(isColumnSelectionGesture(colEventBoth)).toBe(false);
    expect(isAltShiftGesture(colEventCtrl)).toBe(false);

    expect(isColumnSelectionGesture(altShiftEvent)).toBe(false);
    expect(isAltShiftGesture(altShiftEvent)).toBe(true);
  });
});

describe("Column selection additive behavior & retention on production CM geometry", () => {
  it("retains all existing selections and appends column ranges with native normalization", () => {
    const doc = "0123456789\nabcdefghij\n0123456789";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(25),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const view = createProductionMockView({
      state,
      blocks: [
        { from: 0, to: 10, top: 0, bottom: 20, height: 20 },
        { from: 11, to: 21, top: 20, bottom: 40, height: 20 },
        { from: 22, to: 32, top: 40, bottom: 60, height: 20 },
      ],
      defaultLineHeight: 20,
      charWidth: 10,
    });

    // Drag vertically at column 5 (x=60) across line 1 (y=10) and line 2 (y=30)
    const result = computeColumnSelection(
      view,
      { x: 60, y: 10 },
      { x: 60, y: 30 },
      state.selection,
    );

    expect(result.ranges.map((r) => r.from)).toEqual([2, 5, 16, 25]);
    expect(result.main.from).toBe(16);
  });

  it("supports foldback without accumulating intermediate lines", () => {
    const doc = "line1\nline2\nline3\nline4";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(2),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const view = createProductionMockView({
      state,
      blocks: [
        { from: 0, to: 5, top: 0, bottom: 20, height: 20 },
        { from: 6, to: 11, top: 20, bottom: 40, height: 20 },
        { from: 12, to: 17, top: 40, bottom: 60, height: 20 },
        { from: 18, to: 23, top: 60, bottom: 80, height: 20 },
      ],
      defaultLineHeight: 20,
      charWidth: 10,
    });

    // Drag down lines 1..4 (x=30 is column 2)
    const dragDown = computeColumnSelection(
      view,
      { x: 30, y: 10 },
      { x: 30, y: 70 },
      state.selection,
    );
    expect(dragDown.ranges.length).toBe(4);
    expect(dragDown.ranges.map((r) => r.from)).toEqual([2, 8, 14, 20]);

    // Fold back up to line 2 (y=30)
    const foldBack = computeColumnSelection(
      view,
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      state.selection,
    );
    expect(foldBack.ranges.length).toBe(2);
    expect(foldBack.ranges.map((r) => r.from)).toEqual([2, 8]);
  });

  it("preserves previous selection across successive column drag gestures", () => {
    const doc = "0123456789\nabcdefghij\n0123456789";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(2),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const view = createProductionMockView({
      state,
      blocks: [
        { from: 0, to: 10, top: 0, bottom: 20, height: 20 },
        { from: 11, to: 21, top: 20, bottom: 40, height: 20 },
        { from: 22, to: 32, top: 40, bottom: 60, height: 20 },
      ],
      defaultLineHeight: 20,
      charWidth: 10,
    });

    // First drag: column 2 on lines 1 & 2 (x=30)
    const sel1 = computeColumnSelection(
      view,
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      state.selection,
    );
    expect(sel1.ranges.map((r) => r.from)).toEqual([2, 13]);

    // Second drag: column 8 on lines 2 & 3 (x=90)
    const sel2 = computeColumnSelection(
      view,
      { x: 90, y: 30 },
      { x: 90, y: 50 },
      sel1,
    );
    expect(sel2.ranges.map((r) => r.from)).toEqual([2, 13, 19, 30]);
  });
});

describe("Column selection line clipping rules", () => {
  it("clips short lines to real line end and empty lines to line start", () => {
    const doc = "0123456789\nab\n\n0123456789";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(5),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const view = createProductionMockView({
      state,
      blocks: [
        { from: 0, to: 10, top: 0, bottom: 20, height: 20 },
        { from: 11, to: 13, top: 20, bottom: 40, height: 20 },
        { from: 14, to: 14, top: 40, bottom: 60, height: 20 },
        { from: 15, to: 25, top: 60, bottom: 80, height: 20 },
      ],
      defaultLineHeight: 20,
      charWidth: 10,
    });

    // Column 5 is at x=60
    const result = computeColumnSelection(
      view,
      { x: 60, y: 10 },
      { x: 60, y: 70 },
      state.selection,
    );

    expect(result.ranges.length).toBe(4);
    expect(result.ranges[0].from).toBe(5);
    expect(result.ranges[0].to).toBe(5);
    expect(result.ranges[1].from).toBe(13);
    expect(result.ranges[1].to).toBe(13);
    expect(result.ranges[2].from).toBe(14);
    expect(result.ranges[2].to).toBe(14);
    expect(result.ranges[3].from).toBe(20);
    expect(result.ranges[3].to).toBe(20);
  });

  it("clips horizontal span to line end without exceeding short/empty lines", () => {
    const doc = "0123456789\nab\n\n0123456789";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.range(3, 7),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const view = createProductionMockView({
      state,
      blocks: [
        { from: 0, to: 10, top: 0, bottom: 20, height: 20 },
        { from: 11, to: 13, top: 20, bottom: 40, height: 20 },
        { from: 14, to: 14, top: 40, bottom: 60, height: 20 },
        { from: 15, to: 25, top: 60, bottom: 80, height: 20 },
      ],
      defaultLineHeight: 20,
      charWidth: 10,
    });

    // Drag from column 3 (x=40) to column 7 (x=80)
    const result = computeColumnSelection(
      view,
      { x: 40, y: 10 },
      { x: 80, y: 70 },
      state.selection,
    );

    expect(result.ranges[0].from).toBe(3);
    expect(result.ranges[0].to).toBe(7);
    expect(result.ranges[1].from).toBe(13);
    expect(result.ranges[1].to).toBe(13);
    expect(result.ranges[2].from).toBe(14);
    expect(result.ranges[2].to).toBe(14);
    expect(result.ranges[3].from).toBe(18);
    expect(result.ranges[3].to).toBe(22);
  });
});

describe("Wrapped line production branch: short wrapped segments, assoc, and budget", () => {
  it("resolves short wrapped segment when referenceX is far in line end using assoc", () => {
    // Single logical line (0..25) wrapped into 3 segments:
    // Seg 1: 0..10 (len 10)
    // Seg 2: 10..15 (len 5, short segment)
    // Seg 3: 15..25 (len 10)
    const doc = "0123456789abcde0123456789";
    const state = EditorState.create({
      doc,
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const view = createProductionMockView({
      state,
      lineWrapping: true,
      blocks: [
        {
          from: 0,
          to: 25,
          top: 0,
          bottom: 60,
          height: 60,
          segments: [
            { from: 0, to: 10, top: 0, bottom: 20 },
            { from: 10, to: 15, top: 20, bottom: 40 },
            { from: 15, to: 25, top: 40, bottom: 60 },
          ],
        },
      ],
      defaultLineHeight: 20,
      charWidth: 10,
    });

    // Drag vertically starting on Seg 2 (y=30) where referenceX is 500 (far beyond Seg 2 end)
    // down to Seg 3 (y=50)
    const visualLines = getVisualLinesInRect(view, 30, 50, 500);
    expect(visualLines.length).toBe(2);
    // Must start on Seg 2 [10, 15] thanks to assoc=-1, NOT jump ahead to Seg 3
    expect(visualLines[0].from).toBe(10);
    expect(visualLines[0].to).toBe(15);
    // Second segment is Seg 3 [15, 25]
    expect(visualLines[1].from).toBe(15);
    expect(visualLines[1].to).toBe(25);

    // Horizontal drag on Seg 1 (x=30 to x=500) must clamp to Seg 1 end (10)
    // and never swallow char 10 of Seg 2
    const seg1: VisualLine = { from: 0, to: 10, y: 10 };
    const range = computeColumnRangeForLine(view, seg1, 30, 500);
    expect(range.from).toBe(2);
    expect(range.to).toBe(10);
  });

  it("enforces MAX_COLUMN_VISUAL_LINES budget on enormous wrapped blocks without hanging", () => {
    // Enormous wrapped block with 1500 segments
    const segCount = 1500;
    const segments: Array<{ from: number; to: number; top: number; bottom: number }> = [];
    for (let i = 0; i < segCount; i++) {
      segments.push({
        from: i * 10,
        to: (i + 1) * 10,
        top: i * 20,
        bottom: (i + 1) * 20,
      });
    }

    const state = EditorState.create({
      doc: "x".repeat(segCount * 10),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const view = createProductionMockView({
      state,
      lineWrapping: true,
      blocks: [
        {
          from: 0,
          to: segCount * 10,
          top: 0,
          bottom: segCount * 20,
          height: segCount * 20,
          segments,
        },
      ],
      defaultLineHeight: 20,
      charWidth: 10,
    });

    // Drag rectangle spanning all 1500 lines vertically
    const visualLines = getVisualLinesInRect(view, 0, segCount * 20, 20);
    // Must be strictly capped at MAX_COLUMN_VISUAL_LINES (1000)
    expect(visualLines.length).toBe(MAX_COLUMN_VISUAL_LINES);
  });

  it("cleans up all listeners on mouseup and freezes selection", () => {
    class MockTarget {
      listeners: Record<string, Array<{ handler: (e: any) => void; capture: boolean }>> = {};
      addEventListener(type: string, handler: (e: any) => void, useCapture?: boolean | { capture?: boolean }) {
        const capture = typeof useCapture === "boolean" ? useCapture : Boolean(useCapture?.capture);
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push({ handler, capture });
      }
      removeEventListener(type: string, handler: (e: any) => void, useCapture?: boolean | { capture?: boolean }) {
        const capture = typeof useCapture === "boolean" ? useCapture : Boolean(useCapture?.capture);
        if (!this.listeners[type]) return;
        this.listeners[type] = this.listeners[type].filter(
          (l) => l.handler !== handler || l.capture !== capture,
        );
      }
      dispatch(type: string, eventObj: Record<string, unknown> = {}) {
        for (const r of [...(this.listeners[type] || [])]) {
          r.handler({ type, ...eventObj });
        }
      }
      count(type?: string): number {
        if (type) return this.listeners[type]?.length || 0;
        return Object.values(this.listeners).reduce((acc, list) => acc + list.length, 0);
      }
    }

    const mockWin = new MockTarget();
    const mockDoc = new MockTarget();
    const mockContentDOM = new MockTarget() as unknown as HTMLElement & {
      getBoundingClientRect: () => DOMRect;
      count: (type?: string) => number;
    };
    (mockContentDOM as any).ownerDocument = mockDoc;
    (mockContentDOM as any).getBoundingClientRect = () => ({
      left: 10,
      top: 0,
      right: 200,
      bottom: 100,
      width: 190,
      height: 100,
    });

    const state = EditorState.create({
      doc: "0123456789\nabcdefghij",
      selection: EditorSelection.single(2),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const mockView = {
      state,
      documentTop: 0,
      contentDOM: mockContentDOM as HTMLElement,
      win: mockWin as unknown as Window,
      posAtCoords: () => 5,
      posAndSideAtCoords: () => ({ pos: 5, assoc: 1 as const }),
      lineBlockAt: () => ({ from: 0, to: 10, top: 0, bottom: 20, height: 20 }),
      lineBlockAtHeight: () => ({ from: 0, to: 10, top: 0, bottom: 20, height: 20 }),
      coordsAtPos: () => ({ top: 0, bottom: 20, left: 60, right: 70 }),
      moveToLineBoundary: (r: any) => r,
    };

    const startEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 60,
      clientY: 10,
    } as MouseEvent;

    const handler = columnSelectionStyle(mockView as never, startEvent);
    expect(handler).not.toBeNull();

    // Listeners must be actively registered across win, doc, contentDOM
    expect(mockWin.count("mouseup")).toBe(1);
    expect(mockWin.count("keyup")).toBe(1);
    expect(mockWin.count("blur")).toBe(1);
    expect(mockDoc.count("mouseup")).toBe(1);
    expect(mockDoc.count("keydown")).toBe(1);
    expect((mockContentDOM as any).count("focusout")).toBe(1);

    // Mouseup on win immediately cleans up all listeners
    mockWin.dispatch("mouseup", { button: 0 });

    expect(mockWin.count()).toBe(0);
    expect(mockDoc.count()).toBe(0);
    expect((mockContentDOM as any).count()).toBe(0);

    // Subsequent get() call returns frozen selection (view.state.selection)
    const moveEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 100,
      clientY: 30,
    } as MouseEvent;
    const frozenSel = handler.get(moveEvent);
    expect(frozenSel).toBe(state.selection);
  });

  it("cleans up listeners and cancels session on keyup with modifier released, Escape keydown, or explicit cancel", () => {
    class MockTarget {
      listeners: Record<string, Array<{ handler: (e: any) => void; capture: boolean }>> = {};
      addEventListener(type: string, handler: (e: any) => void, useCapture?: boolean | { capture?: boolean }) {
        const capture = typeof useCapture === "boolean" ? useCapture : Boolean(useCapture?.capture);
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push({ handler, capture });
      }
      removeEventListener(type: string, handler: (e: any) => void, useCapture?: boolean | { capture?: boolean }) {
        const capture = typeof useCapture === "boolean" ? useCapture : Boolean(useCapture?.capture);
        if (!this.listeners[type]) return;
        this.listeners[type] = this.listeners[type].filter(
          (l) => l.handler !== handler || l.capture !== capture,
        );
      }
      dispatch(type: string, eventObj: Record<string, unknown> = {}) {
        for (const r of [...(this.listeners[type] || [])]) {
          r.handler({ type, ...eventObj });
        }
      }
      count(): number {
        return Object.values(this.listeners).reduce((acc, list) => acc + list.length, 0);
      }
    }

    const mockWin = new MockTarget();
    const mockDoc = new MockTarget();
    const mockContentDOM = new MockTarget() as unknown as HTMLElement;
    (mockContentDOM as any).ownerDocument = mockDoc;

    const state = EditorState.create({
      doc: "line1\nline2",
      selection: EditorSelection.single(0),
    });

    const mockView = {
      state,
      documentTop: 0,
      contentDOM: mockContentDOM as HTMLElement,
      win: mockWin as unknown as Window,
      posAtCoords: () => 0,
      posAndSideAtCoords: () => ({ pos: 0, assoc: 1 as const }),
      lineBlockAt: () => ({ from: 0, to: 5, top: 0, bottom: 20, height: 20 }),
      lineBlockAtHeight: () => ({ from: 0, to: 5, top: 0, bottom: 20, height: 20 }),
      coordsAtPos: () => ({ top: 0, bottom: 20, left: 10, right: 20 }),
      moveToLineBoundary: (r: any) => r,
    };

    const startEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 20,
      clientY: 10,
    } as MouseEvent;

    // 1. Releasing Ctrl via keyup cancels and removes listeners
    columnSelectionStyle(mockView as never, startEvent);
    expect(mockWin.count()).toBeGreaterThan(0);
    mockWin.dispatch("keyup", { ctrlKey: false, altKey: true, shiftKey: true });
    expect(mockWin.count()).toBe(0);
    expect(mockDoc.count()).toBe(0);

    // 2. Pressing Escape via keydown cancels and removes listeners
    columnSelectionStyle(mockView as never, startEvent);
    expect(mockWin.count()).toBeGreaterThan(0);
    mockDoc.dispatch("keydown", { key: "Escape" });
    expect(mockWin.count()).toBe(0);
    expect(mockDoc.count()).toBe(0);

    // 3. cancelColumnSelection() cancels active session and removes listeners
    columnSelectionStyle(mockView as never, startEvent);
    expect(mockWin.count()).toBeGreaterThan(0);
    cancelColumnSelection();
    expect(mockWin.count()).toBe(0);
    expect(mockDoc.count()).toBe(0);
  });

  it("re-acquires startX relative to contentDOM rect left on horizontal auto-scroll", () => {
    let contentLeft = 100;
    const mockContentDOM = {
      getBoundingClientRect: () => ({
        left: contentLeft,
        top: 0,
        right: contentLeft + 400,
        bottom: 200,
        width: 400,
        height: 200,
      }),
      ownerDocument: null,
    };

    const doc = "0123456789\n0123456789";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(0),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const mockView = {
      state,
      documentTop: 0,
      contentDOM: mockContentDOM as unknown as HTMLElement,
      posAtCoords: (coords: { x: number; y: number }) => {
        const lineOffset = coords.y < 20 ? 0 : 11;
        const col = Math.round((coords.x - contentLeft) / 10);
        return lineOffset + Math.max(0, Math.min(10, col));
      },
      posAndSideAtCoords: (coords: { x: number; y: number }) => {
        const lineOffset = coords.y < 20 ? 0 : 11;
        const col = Math.round((coords.x - contentLeft) / 10);
        return { pos: lineOffset + Math.max(0, Math.min(10, col)), assoc: 1 as const };
      },
      lineBlockAt: (pos: number) =>
        pos < 11
          ? { from: 0, to: 10, top: 0, bottom: 20, height: 20 }
          : { from: 11, to: 21, top: 20, bottom: 40, height: 20 },
      lineBlockAtHeight: (h: number) =>
        h < 20
          ? { from: 0, to: 10, top: 0, bottom: 20, height: 20 }
          : { from: 11, to: 21, top: 20, bottom: 40, height: 20 },
      coordsAtPos: (pos: number) => {
        const lineOffset = pos < 11 ? 0 : 11;
        const col = pos - lineOffset;
        const top = pos < 11 ? 0 : 20;
        return {
          top,
          bottom: top + 20,
          left: contentLeft + col * 10,
          right: contentLeft + (col + 1) * 10,
        };
      },
      moveToLineBoundary: (r: any) => r,
    };

    const startEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 140, // contentLeft(100) + 40 -> col 4
      clientY: 10,
    } as MouseEvent;

    const handler = columnSelectionStyle(mockView as never, startEvent);

    // Horizontal scroll occurs: contentDOM.left shifts from 100 to 60 (scrolled right 40px)
    contentLeft = 60;

    // Pointer moves to clientX = 140 (which is now col 8: (140 - 60) / 10 = 8)
    const moveEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 140,
      clientY: 30,
    } as MouseEvent;

    const sel = handler.get(moveEvent);
    // startX was re-acquired as contentLeft(60) + docOffsetX(40) = 100 -> col 4
    // curX is 140 -> col 8
    // Additive selection preserves initial cursor at 0, plus line 1 range(4, 8) and line 2 range(15, 19)
    expect(sel.ranges.length).toBe(3);
    expect(sel.ranges[0].from).toBe(0);
    expect(sel.ranges[1].from).toBe(4);
    expect(sel.ranges[1].to).toBe(8);
    expect(sel.ranges[2].from).toBe(15);
    expect(sel.ranges[2].to).toBe(19);

    cancelColumnSelection();
  });

  it("uses recorded anchor segment offset within line block when anchor coordsAtPos is null", () => {
    let anchorVisible = true;
    const doc = "0123456789";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(0),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const mockView = {
      state,
      documentTop: 0,
      posAtCoords: (coords: { x: number; y: number }) => {
        return Math.max(0, Math.min(10, Math.round(coords.x / 10)));
      },
      posAndSideAtCoords: (coords: { x: number; y: number }) => {
        return { pos: Math.max(0, Math.min(10, Math.round(coords.x / 10))), assoc: 1 as const };
      },
      lineBlockAt: () => ({ from: 0, to: 10, top: 100, bottom: 180, height: 80 }),
      lineBlockAtHeight: () => ({ from: 0, to: 10, top: 100, bottom: 180, height: 80 }),
      coordsAtPos: () => {
        if (!anchorVisible) return null;
        // Visual segment is at top: 140, bottom: 160 (midY = 150)
        // Offset within block (top: 100) is 150 - 100 = 50
        return { top: 140, bottom: 160, left: 20, right: 30 };
      },
      moveToLineBoundary: (r: any) => r,
    };

    const startEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 20,
      clientY: 150,
    } as MouseEvent;

    const handler = columnSelectionStyle(mockView as never, startEvent);

    // Anchor scrolls offscreen vertically: coordsAtPos becomes null
    anchorVisible = false;

    const moveEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 50,
      clientY: 170,
    } as MouseEvent;

    // get() uses block.top(100) + anchorSegOffsetInBlock(50) = 150
    const sel = handler.get(moveEvent);
    // Additive selection preserves initial cursor at 0 and appends range(2, 5)
    expect(sel.ranges.length).toBe(2);
    expect(sel.ranges[0].from).toBe(0);
    expect(sel.ranges[1].from).toBe(2);
    expect(sel.ranges[1].to).toBe(5);

    cancelColumnSelection();
  });

  it("does not query coordsAtPos or lineBlockAt during style.update, maps anchorPos, and refreshes offset in subsequent get", () => {
    let isUpdating = false;
    let doc = "0123456789\nabcdefghij";
    let state = EditorState.create({
      doc,
      selection: EditorSelection.single(15),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    let segTop = 20;
    const mockView = {
      get state() {
        return state;
      },
      documentTop: 0,
      posAtCoords: (coords: { x: number; y: number }) => {
        const lineOffset = coords.y < 40 ? 0 : 11;
        return lineOffset + Math.max(0, Math.min(10, Math.round(coords.x / 10)));
      },
      posAndSideAtCoords: (coords: { x: number; y: number }) => {
        const lineOffset = coords.y < 40 ? 0 : 11;
        return {
          pos: lineOffset + Math.max(0, Math.min(10, Math.round(coords.x / 10))),
          assoc: 1 as const,
        };
      },
      lineBlockAt: (pos: number) => {
        if (isUpdating) {
          throw new Error("Reading the editor layout isn't allowed during an update");
        }
        return pos < 11
          ? { from: 0, to: 10, top: 0, bottom: 40, height: 40 }
          : { from: 11, to: 21, top: 40, bottom: 80, height: 40 };
      },
      lineBlockAtHeight: (h: number) => {
        return h < 40
          ? { from: 0, to: 10, top: 0, bottom: 40, height: 40 }
          : { from: 11, to: 21, top: 40, bottom: 80, height: 40 };
      },
      coordsAtPos: (pos: number) => {
        if (isUpdating) {
          throw new Error("Reading the editor layout isn't allowed during an update");
        }
        const top = pos < 11 ? segTop : 40;
        return {
          top,
          bottom: top + 20,
          left: 30,
          right: 40,
        };
      },
      moveToLineBoundary: (r: any) => r,
    };

    const startEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 30,
      clientY: 30,
    } as MouseEvent;

    const handler = columnSelectionStyle(mockView as never, startEvent);
    expect(handler).not.toBeNull();

    // Document changes while editor is in Updating state
    const tr = state.update({
      changes: { from: 0, insert: "HELLO" },
    });
    state = tr.state;

    // Simulate CM calling handler.update during updateState=Updating
    isUpdating = true;
    expect(() => {
      handler.update({
        docChanged: true,
        changes: tr.changes,
      } as never);
    }).not.toThrow();
    isUpdating = false;

    // In a subsequent frame / mousemove outside update, layout shifted: segTop changed to 10
    segTop = 10;
    const moveEvent = {
      button: 0,
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      clientX: 70,
      clientY: 50,
    } as MouseEvent;

    // get() executes in safe read phase, refreshes the segment offset, and computes selection
    const sel = handler.get(moveEvent);
    expect(sel).toBeInstanceOf(EditorSelection);
    // Initial cursor at 15 mapped to 20 after inserting 5 characters at 0
    expect(sel.ranges.some((r) => r.from === 20)).toBe(true);

    cancelColumnSelection();
  });
});
