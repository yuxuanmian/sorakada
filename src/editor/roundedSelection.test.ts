import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { RectangleMarker, type EditorView } from "@codemirror/view";
import {
  buildVisualSelectionPieces,
  buildVisualSelectionMarkers,
  ConcaveCornerMarker,
  computeSelectionRadii,
  formatRadius,
  getVisualLineSegments,
  MAX_ROUNDED_RECTS_BUDGET,
  roundedSelection,
  roundedSelectionLayerConfig,
  RoundedRectangleMarker,
  type SelectionRect,
} from "./roundedSelection";

describe("roundedSelection - Static Geometry Adjacency (Spec 013 §5, A13)", () => {
  it("rounds all 4 corners to 3px for an isolated single-line selection", () => {
    const rects: SelectionRect[] = [
      { left: 10, top: 0, width: 80, height: 20 },
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(1);
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 3,
      bottomLeft: 3,
    });
    expect(formatRadius(radii[0])).toBe("3px 3px 3px 3px");
  });

  it("creates seamless vertical connection for contiguous multi-line selection of equal width", () => {
    // Two lines with identical left and right boundaries touching vertically
    const rects: SelectionRect[] = [
      { left: 20, top: 0, width: 100, height: 20 },
      { left: 20, top: 20, width: 100, height: 20 },
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(2);

    // Top rectangle: top corners rounded, bottom corners flat at seam
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 0,
      bottomLeft: 0,
    });

    // Bottom rectangle: top corners flat at seam, bottom corners rounded
    expect(radii[1]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 3,
      bottomLeft: 3,
    });
  });

  it("seamlessly connects continuous narrow 1px/2px placeholder blocks (e.g. newline/empty lines)", () => {
    // Two vertically contiguous narrow blocks (width = 1px)
    const rects: SelectionRect[] = [
      { left: 10, top: 0, width: 1, height: 20 },
      { left: 10, top: 20, width: 1, height: 20 },
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(2);

    // Seam between narrow blocks must be flat (0px) to prevent transparent gap/holes
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 0,
      bottomLeft: 0,
    });
    expect(radii[1]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 3,
      bottomLeft: 3,
    });
  });

  it("handles contiguous multi-line with uneven lengths and indentations without gaps or notches", () => {
    // Typical paragraph selection:
    // Line 1: selection starts mid-line (x=100 to 300)
    // Line 2: full line selected (x=0 to 500)
    // Line 3: selection ends mid-line (x=0 to 150)
    const rects: SelectionRect[] = [
      { left: 100, top: 0, width: 200, height: 20 }, // Line 1: [100, 300]
      { left: 0, top: 20, width: 500, height: 20 }, // Line 2: [0, 500]
      { left: 0, top: 40, width: 150, height: 20 }, // Line 3: [0, 150]
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(3);

    // Line 1: Top corners are exposed (3px), bottom corners meet Line 2 (0px)
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 0,
      bottomLeft: 0,
    });

    // Line 2:
    // - Top-left (x=0..100) extends out: 3px
    // - Top-right (x=300..500) extends out: 3px
    // - Bottom-right (x=150..500) extends out: 3px
    // - Bottom-left (x=0) aligns with Line 3 (x=0): 0px (continuous straight edge)
    expect(radii[1]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 3,
      bottomLeft: 0,
    });

    // Line 3:
    // - Top-left aligns with Line 2: 0px
    // - Top-right (x=150) covered by Line 2 above: 0px
    // - Bottom corners: exposed (3px)
    expect(radii[2]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 3,
      bottomLeft: 3,
    });
  });

  it("handles soft-wrapped visual line shapes correctly", () => {
    // Soft wrap: a long line wraps onto a second visual line
    // Line 1: wraps at right edge (x=20 to 400)
    // Line 2: continues on next visual line from line-start to end of text (x=20 to 250)
    const rects: SelectionRect[] = [
      { left: 20, top: 0, width: 380, height: 20 }, // Line 1: [20, 400]
      { left: 20, top: 20, width: 230, height: 20 }, // Line 2: [20, 250]
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(2);

    // Line 1:
    // - Left edge is aligned with Line 2 (x=20): bottomLeft = 0
    // - Top corners: exposed (3px)
    // - Bottom-right extends past Line 2 (400 > 250): exposed (3px)
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 3,
      bottomLeft: 0,
    });

    // Line 2:
    // - Left edge aligns with Line 1: topLeft = 0
    // - Top-right (x=250) covered by Line 1 above: topRight = 0
    // - Bottom corners: exposed (3px)
    expect(radii[1]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 3,
      bottomLeft: 3,
    });
  });

  it("keeps non-contiguous selections completely independent without merging corners", () => {
    // Selection A on line 1, Selection B on line 4 (vertical gap)
    // Selection C on line 4 separated horizontally (e.g. multiple cursors on same line)
    const rects: SelectionRect[] = [
      { left: 10, top: 0, width: 40, height: 20 }, // Selection A: Line 1
      { left: 10, top: 60, width: 40, height: 20 }, // Selection B: Line 4
      { left: 100, top: 60, width: 50, height: 20 }, // Selection C: Line 4 (horizontal gap)
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(3);

    // Every non-contiguous selection must be completely independent with all 4 corners rounded
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 3,
      bottomLeft: 3,
    });
    expect(radii[1]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 3,
      bottomLeft: 3,
    });
    expect(radii[2]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 3,
      bottomLeft: 3,
    });
  });

  it("treats fractional subpixel differences under ALIGN_X_TOLERANCE as aligned", () => {
    // Line 1: [10.33, 100.25]
    // Line 2: [10.15, 100.40]
    // Subpixel differences: deltaLeft = 0.18px, deltaRight = 0.15px
    const rects: SelectionRect[] = [
      { left: 10.33, top: 0.0, width: 89.92, height: 19.8 },
      { left: 10.15, top: 19.8, width: 90.25, height: 20.1 },
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(2);

    // Neither left nor right edge should develop false notches due to fractional subpixel jitter
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 0,
      bottomLeft: 0,
    });
    expect(radii[1]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 3,
      bottomLeft: 3,
    });
  });

  it("safely degrades to 0px (flat seamless edges) when rectangle count exceeds performance budget", () => {
    const rects: SelectionRect[] = [];
    for (let i = 0; i <= MAX_ROUNDED_RECTS_BUDGET + 10; i++) {
      rects.push({ left: 10, top: i * 20, width: 50, height: 20 });
    }

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(rects.length);
    // Falls back to conservative 0px path to preserve seamless continuity without block gaps
    expect(radii[0]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
  });

  it("handles zero width and zero height gracefully without errors", () => {
    const rects: SelectionRect[] = [
      { left: 10, top: 0, width: 0, height: 20 },
      { left: 20, top: 20, width: 50, height: 0 },
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(2);
    expect(radii[0]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
    expect(radii[1]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
  });

  it("does not let zero-size adjacent rectangles misjudge normal block corners", () => {
    const rects: SelectionRect[] = [
      { left: 10, top: 0, width: 80, height: 20 },
      { left: 10, top: 20, width: 0, height: 20 },
    ];

    const radii = computeSelectionRadii(rects);
    expect(radii).toHaveLength(2);
    // Normal rect remains fully rounded (not flattened by the 0-width block)
    expect(radii[0]).toEqual({
      topLeft: 3,
      topRight: 3,
      bottomRight: 3,
      bottomLeft: 3,
    });
    // 0-width rect has 0px
    expect(radii[1]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
  });

  it("exports roundedSelection extension compatible with EditorState", () => {
    const ext = roundedSelection();
    expect(Array.isArray(ext)).toBe(true);

    // Ensure creating an EditorState with this extension succeeds without errors
    const state = EditorState.create({
      doc: "hello world\nsecond line\nthird line",
      extensions: [ext],
    });
    expect(state.doc.toString()).toContain("hello world");
  });
});

interface MockVisualLine {
  from: number;
  to: number;
  top: number;
  bottom: number;
  left?: number;
}

interface MockSegment {
  from: number;
  to: number;
  top: number;
  bottom: number;
  left?: number;
}

function createMockGeometryView(options: {
  doc: string;
  selection: { from: number; to: number } | EditorSelection;
  lines: MockVisualLine[];
  charWidth?: number;
  lineHeight?: number;
  lineWrapping?: boolean;
  wrapBoundaries?: Record<number, number>;
  segments?: MockSegment[];
}) {
  const charWidth = options.charWidth || 10;
  const state = EditorState.create({
    doc: options.doc,
    selection: options.selection instanceof EditorSelection ? options.selection : EditorSelection.single(
      options.selection.from,
      options.selection.to,
    ),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });

  const findLine = (pos: number): MockVisualLine => {
    for (const l of options.lines) {
      if (pos >= l.from && pos <= l.to) return l;
    }
    return options.lines[options.lines.length - 1];
  };

  return {
    state,
    viewport: { from: 0, to: options.doc.length },
    viewportLineBlocks: options.lines.map((l) => ({ from: l.from, to: l.to })),
    lineWrapping: options.lineWrapping ?? false,
    defaultCharacterWidth: charWidth,
    moveToLineBoundary: (cursor: { head: number }, forward = true) => {
      if (!forward) {
        if (options.segments) {
          for (const s of options.segments) {
            if (cursor.head >= s.from && cursor.head <= s.to) {
              return EditorSelection.cursor(s.from);
            }
          }
        }
        return EditorSelection.cursor(findLine(cursor.head).from);
      }
      const target =
        options.wrapBoundaries &&
        options.wrapBoundaries[cursor.head] !== undefined
          ? options.wrapBoundaries[cursor.head]
          : findLine(cursor.head).to;
      return EditorSelection.cursor(target);
    },
    coordsAtPos: (pos: number, side = 1) => {
      if (options.segments) {
        for (const s of options.segments) {
          const inRange =
            side >= 0
              ? pos >= s.from && (pos < s.to || s.to === options.doc.length)
              : pos > s.from && pos <= s.to;
          if (inRange || (pos === s.from && pos === s.to)) {
            const x = (s.left ?? 0) + (pos - s.from) * charWidth;
            return { left: x, right: x, top: s.top, bottom: s.bottom };
          }
        }
      }
      const line = findLine(pos);
      const startX = line.left ?? 0;
      const x = startX + (pos - line.from) * charWidth;
      return {
        left: x,
        right: x,
        top: line.top,
        bottom: line.bottom,
      };
    },
    defaultLineHeight: options.lineHeight ?? 20,
  };
}

describe("roundedSelection - Visual Line Slicing & Middle Slab Elimination (Spec 013 §5, A13)", () => {
  it.each([true, false])("fills both inner step corners with circle holes (narrow row below=%s)", (narrowBelow) => {
    const doc = narrowBelow ? "abcdefghij\nklmno" : "abcde\nfghijklmno";
    const split = doc.indexOf("\n");
    const view = createMockGeometryView({
      doc, selection: { from: 0, to: doc.length }, lineHeight: 32,
      lines: [
        { from: 0, to: split, left: narrowBelow ? 0 : 20, top: 5, bottom: 25 },
        { from: split + 1, to: doc.length, left: narrowBelow ? 20 : 0, top: 37, bottom: 57 },
      ],
    });
    const selection = view.state.selection;
    const markers = buildVisualSelectionMarkers(view);
    const bodies = markers.filter((m): m is RoundedRectangleMarker => m instanceof RoundedRectangleMarker);
    const patches = markers.filter((m): m is ConcaveCornerMarker => m instanceof ConcaveCornerMarker);
    expect(patches.map(p => ({ left: p.left, top: p.top, radius: p.width, hole: p.hole }))).toEqual([
      { left: 17, top: narrowBelow ? 31 : 28, radius: 3, hole: narrowBelow ? "left bottom" : "left top" },
      { left: narrowBelow ? 70 : 75, top: narrowBelow ? 31 : 28, radius: 3, hole: narrowBelow ? "right bottom" : "right top" },
    ]);
    expect(bodies.map(p => p.width)).toEqual(narrowBelow ? [105, 50] : [55, 100]);
    expect(bodies[0].top + bodies[0].height).toBe(bodies[1].top);
    expect(bodies[0].radii.topLeft).toBe(3);
    expect(bodies[1].radii.bottomRight).toBe(3);
    for (const patch of patches) {
      // Even the entire mask square occupies only missing area, never blue-on-blue.
      for (const other of [...bodies, ...patches.filter(p => p !== patch)]) {
        const overlapX = Math.min(patch.left + patch.width!, other.left + other.width!) - Math.max(patch.left, other.left);
        const overlapY = Math.min(patch.top + patch.height, other.top + other.height) - Math.max(patch.top, other.top);
        expect(Math.max(0, overlapX) * Math.max(0, overlapY)).toBe(0);
      }
      const element = { style: {} } as HTMLDivElement;
      expect(patch.update(element, patch)).toBe(true);
      expect(element.style.maskImage).toBe(`radial-gradient(circle 3px at ${patch.hole}, transparent 3px, #000 3px)`);
    }
    expect(view.state.selection).toBe(selection);
    expect(view.state.sliceDoc(selection.main.from, selection.main.to)).toBe(doc);
  });

  it("shares short ledges between convex and concave arcs and avoids an independent range", () => {
    const view = createMockGeometryView({
      doc: "ab\ncd", selection: { from: 0, to: 5 }, lineHeight: 32,
      lines: [
        { from: 0, to: 2, top: 5, bottom: 25 },
        { from: 3, to: 5, left: 3, top: 37, bottom: 57 },
      ],
    });
    const markers = buildVisualSelectionMarkers(view);
    const patches = markers.filter((m): m is ConcaveCornerMarker => m instanceof ConcaveCornerMarker);
    expect(patches.map(p => p.width)).toEqual([1.5, 1]);
    const bodies = markers.filter((m): m is RoundedRectangleMarker => m instanceof RoundedRectangleMarker);
    expect(bodies[0].radii.bottomLeft).toBe(1.5);
    expect(bodies[1].radii.topRight).toBe(0);

    const nearby = createMockGeometryView({
      doc: "abcdefghij\nklmnopqrst", charWidth: 1, lineHeight: 20,
      selection: EditorSelection.create([EditorSelection.range(0, 16), EditorSelection.range(17, 19)]),
      lines: [
        { from: 0, to: 10, top: 0, bottom: 20 },
        { from: 11, to: 21, top: 20, bottom: 40 },
      ],
    });
    const nearbyMarkers = buildVisualSelectionMarkers(nearby);
    const inner = nearbyMarkers.filter((m): m is ConcaveCornerMarker => m instanceof ConcaveCornerMarker);
    expect(inner).toHaveLength(1);
    expect(inner[0].hole).toBe("right bottom");
    expect(inner[0].width).toBeGreaterThan(0);
    expect(inner[0].left + inner[0].width!).toBeLessThan(6); // Independent background starts at x=6.

    const independent = createMockGeometryView({
      doc: "abcdefghij\nklmno", lineHeight: 32,
      selection: EditorSelection.create([EditorSelection.range(0, 10), EditorSelection.range(11, 16)]),
      lines: [
        { from: 0, to: 10, top: 5, bottom: 25 },
        { from: 11, to: 16, top: 37, bottom: 57 },
      ],
    });
    expect(buildVisualSelectionMarkers(independent).some(m => m instanceof ConcaveCornerMarker)).toBe(false);
  });

  it("never paints a final empty EOF line, regardless of selection direction or anchor", () => {
    const lines = [
      { from: 0, to: 3, top: 5, bottom: 25 },
      { from: 4, to: 4, top: 37, bottom: 57 },
    ];
    const reverse = createMockGeometryView({
      doc: "abc\n", lines, lineHeight: 32,
      selection: EditorSelection.single(4, 0),
    });
    const selection = reverse.state.selection;
    expect(buildVisualSelectionPieces(reverse)).toEqual([
      { left: 0, top: 5, width: 35, height: 20 },
    ]);
    expect(reverse.state.selection).toBe(selection);
    expect(selection.main.anchor).toBe(4);
    expect(selection.main.head).toBe(0);
    expect(reverse.state.sliceDoc(selection.main.from, selection.main.to)).toBe("abc\n");
    const forward = createMockGeometryView({
      doc: "abc\n", lines, lineHeight: 32, selection: EditorSelection.single(0, 4),
    });
    expect(buildVisualSelectionPieces(forward)).toEqual([{ left: 0, top: 5, width: 35, height: 20 }]);
    const cursor = createMockGeometryView({
      doc: "abc\n", lines, lineHeight: 32, selection: EditorSelection.cursor(4),
    });
    expect(buildVisualSelectionPieces(cursor)).toEqual([]);
    const nonFinal = createMockGeometryView({
      doc: "a\n\nb", lineHeight: 32, selection: EditorSelection.single(2, 0),
      lines: [
        { from: 0, to: 1, top: 5, bottom: 25 },
        { from: 2, to: 2, top: 37, bottom: 57 },
        { from: 3, to: 4, top: 69, bottom: 89 },
      ],
    });
    expect(buildVisualSelectionPieces(nonFinal)).toHaveLength(1);
  });

  it("joins glyph-height backgrounds through an empty row at measured midpoints without overlap", () => {
    const view = createMockGeometryView({
      doc: "short\n\nlong",
      selection: { from: 0, to: 11 },
      lineHeight: 32,
      lines: [
        { from: 0, to: 5, top: 5, bottom: 25 },
        { from: 6, to: 6, top: 37, bottom: 57 },
        { from: 7, to: 11, top: 69, bottom: 89 },
      ],
    });
    const originalSelection = view.state.selection;
    const pieces = buildVisualSelectionPieces(view);
    expect(pieces).toEqual([
      { left: 0, top: 5, width: 55, height: 26 },
      { left: 0, top: 31, width: 5, height: 32 },
      { left: 0, top: 63, width: 40, height: 26 },
    ]);
    expect(pieces[0].top + pieces[0].height).toBe(pieces[1].top);
    expect(pieces[1].top + pieces[1].height).toBe(pieces[2].top);
    const radii = computeSelectionRadii(pieces);
    expect(radii.map(r => [r.topLeft, r.bottomLeft])).toEqual([[3, 0], [0, 0], [0, 3]]);
    expect(view.state.selection).toBe(originalSelection);
    expect(view.state.sliceDoc(originalSelection.main.from, originalSelection.main.to)).toBe("short\n\nlong");
  });

  it("joins soft-wrapped glyph rows without changing their horizontal extent", () => {
    const view = createMockGeometryView({
      doc: "abcdefgh",
      selection: { from: 1, to: 7 },
      lineHeight: 32,
      lineWrapping: true,
      lines: [{ from: 0, to: 8, top: 5, bottom: 57 }],
      wrapBoundaries: { 0: 4, 4: 8 },
      segments: [
        { from: 0, to: 4, top: 5, bottom: 25 },
        { from: 4, to: 8, top: 37, bottom: 57 },
      ],
    });
    expect(buildVisualSelectionPieces(view)).toEqual([
      { left: 10, top: 5, width: 30, height: 26 },
      { left: 0, top: 31, width: 30, height: 26 },
    ]);
  });

  it("extends every bidi fragment in a row to the same seam without stacking backgrounds", () => {
    const view = createMockGeometryView({
      doc: "ab\ncd\n",
      selection: { from: 0, to: 6 },
      lineHeight: 32,
      lines: [
        { from: 0, to: 2, top: 5, bottom: 25 },
        { from: 3, to: 5, top: 37, bottom: 57 },
      ],
    });
    // Public CM geometry may return several horizontal fragments for one row.
    const geometry = vi.spyOn(RectangleMarker, "forRange").mockImplementation((_view, className, range) => {
      const top = range.from === 0 ? 5 : 37;
      return [
        new RectangleMarker(className, 0, top, 10, 20),
        new RectangleMarker(className, 10, top, 10, 20),
      ];
    });
    try {
      expect(buildVisualSelectionPieces(view)).toEqual([
        { left: 0, top: 5, width: 10, height: 26 },
        { left: 10, top: 5, width: 15, height: 26 },
        { left: 0, top: 31, width: 10, height: 26 },
        { left: 10, top: 31, width: 15, height: 26 },
      ]);
      expect(buildVisualSelectionMarkers(view).some(m => m instanceof ConcaveCornerMarker)).toBe(false);
    } finally {
      geometry.mockRestore();
    }
  });

  it("does not bridge independent ranges, skipped rows, or large layout gaps", () => {
    const lines = [
      { from: 0, to: 2, top: 5, bottom: 25 },
      { from: 3, to: 5, top: 37, bottom: 57 },
    ];
    const independent = createMockGeometryView({
      doc: "aa\nbb", lineHeight: 32, lines,
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)]),
    });
    const largeGap = createMockGeometryView({
      doc: "aa\nbb", lineHeight: 32, selection: { from: 0, to: 5 },
      lines: [lines[0], { ...lines[1], top: 101, bottom: 121 }],
    });
    const skipped = createMockGeometryView({
      doc: "aa\nbb\ncc", lineHeight: 32, selection: { from: 0, to: 8 },
      lines: [...lines, { from: 6, to: 8, top: 69, bottom: 89 }],
    });
    for (const view of [independent, largeGap, {
      ...skipped, visibleRanges: [{ from: 0, to: 2 }, { from: 6, to: 8 }],
    }]) {
      const pieces = buildVisualSelectionPieces(view);
      expect(pieces).toHaveLength(2);
      expect(pieces[0].top).toBe(5);
      expect(pieces[0].height).toBe(20);
      expect(pieces[1].height).toBe(20);
      expect(pieces[1].top).toBeGreaterThan(pieces[0].top + pieces[0].height);
    }
  });

  it("clips selections to text end for empty-short-empty-long lines without full-width slabs", () => {
    // Line 1: empty ("") [0..0]
    // Line 2: short ("short") [1..6]
    // Line 3: empty ("") [7..7]
    // Line 4: long ("long line of text with content") [8..38]
    const doc = "\nshort\n\nlong line of text with content";
    const lines: MockVisualLine[] = [
      { from: 0, to: 0, top: 0, bottom: 20 },
      { from: 1, to: 6, top: 20, bottom: 40 },
      { from: 7, to: 7, top: 40, bottom: 60 },
      { from: 8, to: 38, top: 60, bottom: 80 },
    ];

    // Selection covers Line 1, Line 2, Line 3, and reaches pos 25 in Line 4
    const view = createMockGeometryView({
      doc,
      selection: { from: 0, to: 25 },
      lines,
      charWidth: 10,
    });

    const pieces = buildVisualSelectionPieces(view);
    expect(pieces).toHaveLength(4);

    // 1. Empty Line 1: its real selected newline contributes 5px.
    expect(pieces[0]).toEqual({
      left: 0,
      top: 0,
      width: 5,
      height: 20,
    });

    // 2. Short Line 2: 5 selected characters plus its selected newline.
    expect(pieces[1]).toEqual({
      left: 0,
      top: 20,
      width: 55,
      height: 20,
    });

    // 3. Empty Line 3: the same fixed hint width.
    expect(pieces[2]).toEqual({
      left: 0,
      top: 40,
      width: 5,
      height: 20,
    });

    // 4. The partial last line contains 17 selected characters, no selected newline.
    expect(pieces[3]).toEqual({
      left: 0,
      top: 60,
      width: 170,
      height: 20,
    });

    // Now compute radii: seamless vertical connection without pores
    const radii = computeSelectionRadii(pieces);
    expect(radii).toHaveLength(4);

    // Line 1: bottom-left seam with Line 2 is flat (0px)
    expect(radii[0].bottomLeft).toBe(0);

    // Line 2: top seam flat (0px), bottom seam touching Line 3 flat (0px), exposed bottom-right 3px
    expect(radii[1].topLeft).toBe(0);
    expect(radii[1].bottomLeft).toBe(0);
    expect(radii[1].bottomRight).toBe(3);

    // Line 3: top and bottom seams flat (0px)
    expect(radii[2].topLeft).toBe(0);
    expect(radii[2].bottomLeft).toBe(0);

    // Line 4: top seam flat (0px), exposed top-right 3px, bottom corners 3px
    expect(radii[3].topLeft).toBe(0);
    expect(radii[3].topRight).toBe(3);
    expect(radii[3].bottomLeft).toBe(3);
    expect(radii[3].bottomRight).toBe(3);
  });

  it("preserves highlight over actual typed trailing spaces", () => {
    // Line 1 has "hello   " (5 chars + 3 trailing spaces = 8 chars)
    // Line 2 has "world"
    const doc = "hello   \nworld";
    const lines: MockVisualLine[] = [
      { from: 0, to: 8, top: 0, bottom: 20 },
      { from: 9, to: 14, top: 20, bottom: 40 },
    ];

    // Selection covers line 1 including trailing spaces and into line 2
    const view = createMockGeometryView({
      doc,
      selection: { from: 0, to: 12 },
      lines,
      charWidth: 10,
    });

    const pieces = buildVisualSelectionPieces(view);
    expect(pieces).toHaveLength(2);

    // All three real trailing spaces and the selected newline remain visible.
    expect(pieces[0].width).toBe(85);
    // The partial last line has no selected newline and receives no extra width.
    expect(pieces[1].width).toBe(30);
  });

  it("keeps underlying document text and selection range intact during visual slicing", () => {
    const doc = "first line\nsecond line\nthird line";
    const view = createMockGeometryView({
      doc,
      selection: { from: 6, to: 24 },
      lines: [
        { from: 0, to: 10, top: 0, bottom: 20 },
        { from: 11, to: 22, top: 20, bottom: 40 },
        { from: 23, to: 33, top: 40, bottom: 60 },
      ],
      charWidth: 10,
    });

    // Visual pieces are computed
    const pieces = buildVisualSelectionPieces(view);
    expect(pieces.length).toBeGreaterThan(0);

    // Verify that the editor state's selection was NOT split or mutated
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(view.state.selection.main.from).toBe(6);
    expect(view.state.selection.main.to).toBe(24);

    // Selected text retains original newlines
    const selectedText = view.state.sliceDoc(6, 24);
    expect(selectedText).toBe("line\nsecond line\nt");
  });

  it("clips wrapped visual segments to text extent and preserves vertical seamlessness", () => {
    // Logical Line [0..50] wraps into:
    // Visual Segment 1: [0..30]
    // Visual Segment 2: [30..50]
    const doc = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP";
    const lines: MockVisualLine[] = [
      { from: 0, to: 50, top: 0, bottom: 20 },
    ];

    // Selection covers 10..45 (crosses the wrap point at 30)
    const view = createMockGeometryView({
      doc,
      selection: { from: 10, to: 45 },
      lines,
      charWidth: 10,
      lineWrapping: true,
      wrapBoundaries: {
        0: 30, // pos 0 wraps at 30
        30: 50, // pos 30 ends at 50
      },
      segments: [
        { from: 0, to: 30, top: 0, bottom: 20, left: 0 },
        { from: 30, to: 50, top: 20, bottom: 40, left: 0 },
      ],
    });

    const pieces = buildVisualSelectionPieces(view);
    expect(pieces).toHaveLength(2);

    // A soft-wrap boundary adds no width to these 20 selected characters.
    expect(pieces[0]).toEqual({
      left: 100,
      top: 0,
      width: 200,
      height: 20,
    });

    // Segment 2 contains 15 selected characters and no newline.
    expect(pieces[1]).toEqual({
      left: 0,
      top: 20,
      width: 150,
      height: 20,
    });
  });

  it("creates RoundedRectangleMarker instances with matching corner radii", () => {
    const marker = new RoundedRectangleMarker("cm-selectionBackground", 10, 0, 50, 20, {
      topLeft: 3,
      topRight: 3,
      bottomRight: 0,
      bottomLeft: 0,
    });

    expect(marker.left).toBe(10);
    expect(marker.width).toBe(50);
    expect(marker.radii.topLeft).toBe(3);
    expect(marker.radii.bottomLeft).toBe(0);
  });

  it.each([
    { name: "empty selected newline", doc: "\nnext", from: 0, to: 1, expected: [{ left: 0, width: 5 }] },
    { name: "one space and newline", doc: " \nnext", from: 0, to: 2, expected: [{ left: 0, width: 15 }] },
    { name: "line end without newline", doc: "a \nnext", from: 0, to: 2, expected: [{ left: 0, width: 20 }] },
    { name: "only a real trailing space", doc: "a \nnext", from: 1, to: 2, expected: [{ left: 10, width: 10 }] },
    { name: "text ending at EOF", doc: "a ", from: 0, to: 2, expected: [{ left: 0, width: 20 }] },
    { name: "partial first and last lines", doc: "ab\nc ", from: 1, to: 4,
      expected: [{ left: 10, width: 15 }, { left: 0, width: 10 }] },
  ])("renders only real selected content plus selected newlines: $name", ({ doc, from, to, expected }) => {
    const source = EditorState.create({ doc });
    const lines = Array.from({ length: source.doc.lines }, (_, index) => {
      const line = source.doc.line(index + 1);
      return { from: line.from, to: line.to, top: index * 20, bottom: (index + 1) * 20 };
    });
    let forward: SelectionRect[] | undefined;
    for (const [anchor, head] of [[from, to], [to, from]]) {
      const view = createMockGeometryView({ doc, lines, charWidth: 10, selection: EditorSelection.single(anchor, head) });
      const selection = view.state.selection;
      const pieces = buildVisualSelectionPieces(view);
      expect(pieces.map(p => ({ left: p.left, width: p.width }))).toEqual(expected);
      if (forward) expect(pieces).toEqual(forward);
      else forward = pieces;
      expect(view.state.selection).toBe(selection);
      expect(selection.main.anchor).toBe(anchor);
      expect(selection.main.head).toBe(head);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.sliceDoc(selection.main.from, selection.main.to)).toBe(doc.slice(from, to));
    }
  });

  it("adds newline width only to the last visual segment of a wrapped logical line", () => {
    const options = {
      doc: "abcd\ne", lineWrapping: true,
      lines: [{ from: 0, to: 4, top: 0, bottom: 40 }, { from: 5, to: 6, top: 40, bottom: 60 }],
      wrapBoundaries: { 0: 2, 2: 4, 5: 6 },
      segments: [
        { from: 0, to: 2, top: 0, bottom: 20 },
        { from: 2, to: 4, top: 20, bottom: 40 },
        { from: 5, to: 6, top: 40, bottom: 60 },
      ],
    };
    for (const selection of [EditorSelection.single(0, 6), EditorSelection.single(6, 0)]) {
      expect(buildVisualSelectionPieces(createMockGeometryView({ ...options, selection })).map(p => p.width))
        .toEqual([20, 25, 10]);
    }
  });

  it.each([{ text: "a", charWidth: 6 }, { text: "中", charWidth: 24 }])(
    "uses a 5px newline-only marker after $text without selecting extra characters", ({ text, charWidth }) => {
      const view = createMockGeometryView({
        doc: `${text}\nnext`, charWidth, selection: { from: 1, to: 2 },
        lines: [
          { from: 0, to: 1, top: 0, bottom: 20 },
          { from: 2, to: 6, top: 20, bottom: 40 },
        ],
      });
      const selection = view.state.selection;
      expect(buildVisualSelectionPieces(view)).toEqual([
        { left: charWidth, top: 0, width: 5, height: 20 },
      ]);
      expect(view.state.selection).toBe(selection);
      expect(view.state.sliceDoc(selection.main.from, selection.main.to)).toBe("\n");
    },
  );

  it("uses assoc = 1 at wrap boundary without slicing UTF-16 surrogate pairs (emoji) and breaks safely if geometry stalls", () => {
    // Text: "abc \uD83D\uDE80 def" where \uD83D\uDE80 is a 2-unit emoji at [4, 6]
    // Soft-wrap happens at pos 4 (immediately before the emoji)
    const doc = "abc \uD83D\uDE80 def"; // length: 10
    const assocsReceived: number[] = [];

    const mockView = {
      lineWrapping: true,
      moveToLineBoundary: (
        range: SelectionRange,
        forward: boolean,
        _includeWrap?: boolean,
      ) => {
        if (!forward) return EditorSelection.cursor(range.head <= 4 ? 0 : 4);
        assocsReceived.push(range.assoc);
        // If cursor is at pos 4 with assoc <= 0, real CM would return 4 (previous line end)
        if (range.head === 4 && range.assoc <= 0) {
          return EditorSelection.cursor(4);
        }
        // With assoc = 1, pos 4 wraps forward to visual segment [4, 10]
        if (range.head === 0) return EditorSelection.cursor(4);
        return EditorSelection.cursor(10);
      },
    };

    const segments = getVisualLineSegments(mockView, 0, doc.length);
    expect(segments).toEqual([
      { from: 0, to: 4 },
      { from: 4, to: 10 },
    ]);
    // Verifies assoc = 1 was used at the wrap boundary
    expect(assocsReceived).toContain(1);

    // Verify surrogate pair "\uD83D\uDE80" at [4, 6] is preserved whole in segment [4, 10] without cutting at [4, 5]
    expect(doc.slice(segments[1].from, segments[1].to)).toBe("\uD83D\uDE80 def");

    // Also verify conservative break if moveToLineBoundary stalls (does not advance)
    const stallingView = {
      lineWrapping: true,
      moveToLineBoundary: () => EditorSelection.cursor(0), // always returns 0
    };
    const stalledSegments = getVisualLineSegments(stallingView, 0, 10);
    // Unmeasurable wrapped geometry must not become a full-width slab.
    expect(stalledSegments).toEqual([]);
  });

  it("locates visible visual segments when scrolled to middle of a huge wrapped block without scanning off-screen lines", () => {
    // A huge logical line of 10,000 chars wrapped every 50 chars (200 visual lines)
    // Viewport is scrolled to [5000, 5150] (visual lines around line 100)
    let moveCalls = 0;
    const mockView = {
      lineWrapping: true,
      moveToLineBoundary: (
        range: SelectionRange,
        forward: boolean,
        _includeWrap?: boolean,
      ) => {
        moveCalls++;
        const lineIdx = Math.floor(range.head / 50);
        if (!forward) {
          return EditorSelection.cursor(lineIdx * 50);
        }
        return EditorSelection.cursor(Math.min(10000, (lineIdx + 1) * 50));
      },
    };

    const segments = getVisualLineSegments(mockView, 0, 10000, 5000, 5150);
    // Should start at 5000 and cover up to 5150 (3 or 4 segments of length 50)
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments[0].from).toBe(5000);
    expect(segments[segments.length - 1].to).toBeGreaterThanOrEqual(5150);

    // Crucial: It must NOT have iterated the preceding 100 visual lines (0..5000)
    expect(moveCalls).toBeLessThan(10);
  });

  it("renders all visible pieces with flat 0px corners when pieces exceed MAX_ROUNDED_RECTS_BUDGET without dropping rectangles", () => {
    // Exercise both the rounding threshold and the former render cutoff.
    const totalLines = 2501;
    const lines: MockVisualLine[] = [];
    const docParts: string[] = [];
    for (let i = 0; i < totalLines; i++) {
      lines.push({ from: i * 5, to: i * 5 + 4, top: i * 20, bottom: (i + 1) * 20 });
      docParts.push("test");
    }
    const doc = docParts.join("\n");

    const view = createMockGeometryView({
      doc,
      selection: { from: 0, to: doc.length },
      lines,
      charWidth: 10,
    });
    (view as { viewport: { from: number; to: number } }).viewport = {
      from: 0,
      to: doc.length,
    };

    const pieces = buildVisualSelectionPieces(view);
    // All drawn pieces remain visible; only expensive rounding degrades.
    expect(pieces).toHaveLength(totalLines);
    const markers = buildVisualSelectionMarkers(view);
    expect(markers).toHaveLength(totalLines);
    expect(markers.every(m => m instanceof RoundedRectangleMarker &&
      Object.values(m.radii).every(radius => radius === 0))).toBe(true);

    // Above the adjacency budget, retain every piece with flat corners.
    const radii = computeSelectionRadii(pieces);
    expect(radii).toHaveLength(totalLines);
    expect(radii[0]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
    expect(radii[totalLines - 1]).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
  });

  it("verifies layer class registration contract (single token class and mount adds cm-selectionLayer)", () => {
    const classes = new Set<string>();
    const dom = {
      classList: {
        add(token: string) {
          if (!token || /\s/.test(token)) throw new Error("InvalidCharacterError");
          classes.add(token);
        },
      },
    } as unknown as HTMLElement;
    // Match the public layer constructor's single-token registration and mount.
    expect(roundedSelectionLayerConfig.class).toBeDefined();
    dom.classList.add(roundedSelectionLayerConfig.class!);
    expect(roundedSelectionLayerConfig.mount).toBeTypeOf("function");
    roundedSelectionLayerConfig.mount!(dom, {} as EditorView);
    expect([...classes]).toEqual(["cm-roundedSelectionLayer", "cm-selectionLayer"]);
  });

  it("draws a selected newline at the preceding line end", () => {
    const view = createMockGeometryView({
      doc: "hello\nworld",
      selection: { from: 5, to: 6 },
      lines: [
        { from: 0, to: 5, top: 0, bottom: 20 },
        { from: 6, to: 11, top: 20, bottom: 40 },
      ],
    });
    expect(buildVisualSelectionPieces(view)).toEqual([
      { left: 50, top: 0, width: 5, height: 20 },
    ]);
  });

  it("uses drawn ranges inside a logical-line viewport when scrolled past a long-line gap", () => {
    const view = createMockGeometryView({
      doc: "x".repeat(10000),
      selection: { from: 0, to: 10000 },
      lines: [{ from: 0, to: 10000, top: -2000, bottom: 2000 }],
      lineWrapping: true,
      wrapBoundaries: { 5000: 5050, 5050: 5100, 5100: 5150 },
      segments: [
        { from: 5000, to: 5050, top: 0, bottom: 20 },
        { from: 5050, to: 5100, top: 20, bottom: 40 },
        { from: 5100, to: 5150, top: 40, bottom: 60 },
      ],
    });
    const pieces = buildVisualSelectionPieces({
      ...view, visibleRanges: [{ from: 5000, to: 5150 }],
    });
    expect(pieces.map(({ top, width }) => ({ top, width }))).toEqual([
      { top: 0, width: 500 }, { top: 20, width: 500 }, { top: 40, width: 500 },
    ]);
  });
});
