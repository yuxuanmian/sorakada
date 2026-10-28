import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  handleDragSelectionMousedown,
  isClickInPrimarySelection,
} from "./dragSelection";
import { emptyLineMouseSelectionStyle } from "./emptyLineSelection";
import { multiCursorMouse } from "./multiCursorMouse";

interface MockCoords {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface CreateMockViewOptions {
  doc: string;
  selection?: EditorSelection;
  charWidth?: number;
  lineHeight?: number;
  charCoordsMap?: Record<number, MockCoords | null>;
  posSideMap?: Record<string, { pos: number; assoc: -1 | 1 }>;
  contentDOM?: HTMLElement;
}

function createMockView(options: CreateMockViewOptions) {
  const charWidth = options.charWidth ?? 10;
  const lineHeight = options.lineHeight ?? 20;

  let state = EditorState.create({
    doc: options.doc,
    selection: options.selection ?? EditorSelection.single(0),
  });

  const mockContentDOM = options.contentDOM ?? ({
    contains: (_node: unknown) => true,
  } as unknown as HTMLElement);

  const view = {
    get state() {
      return state;
    },
    contentDOM: mockContentDOM,
    dispatch: vi.fn((tr: { selection?: EditorSelection }) => {
      if (tr.selection) {
        state = state.update({ selection: tr.selection }).state;
      }
    }),
    posAndSideAtCoords: vi.fn((coords: { x: number; y: number }) => {
      const key = `${coords.x},${coords.y}`;
      if (options.posSideMap && options.posSideMap[key]) {
        return options.posSideMap[key];
      }
      const lineIdx = Math.max(0, Math.floor(coords.y / lineHeight));
      const lineNum = Math.min(state.doc.lines, lineIdx + 1);
      const line = state.doc.line(lineNum);

      const relX = Math.max(0, coords.x);
      const charCol = Math.floor(relX / charWidth);
      const inCharOffset = relX % charWidth;

      if (charCol >= line.length) {
        return { pos: line.to, assoc: -1 as const };
      }

      if (inCharOffset < charWidth / 2) {
        return { pos: line.from + charCol, assoc: 1 as const };
      } else {
        return { pos: line.from + charCol + 1, assoc: -1 as const };
      }
    }),
    coordsForChar: vi.fn((pos: number) => {
      if (options.charCoordsMap && pos in options.charCoordsMap) {
        return options.charCoordsMap[pos];
      }
      if (pos < 0 || pos >= state.doc.length) {
        return null;
      }
      const line = state.doc.lineAt(pos);
      if (pos === line.to) {
        return null;
      }
      const top = (line.number - 1) * lineHeight;
      const bottom = top + lineHeight;
      const col = pos - line.from;
      const left = col * charWidth;
      return {
        left,
        right: left + charWidth,
        top,
        bottom,
      };
    }),
  };

  return { view, getState: () => state };
}

function createMouseEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    detail: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    clientX: 0,
    clientY: 10,
    target: { nodeType: 1 } as unknown as EventTarget,
    ...overrides,
  } as MouseEvent;
}

describe("isClickInPrimarySelection boundary & layout hit-testing", () => {
  it("identifies clicks on characters inside the selection as inside", () => {
    // doc: "abcdef", selection: [0, 2) ("ab")
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    // Click on character 0 (left half: x=2, right half: x=8)
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 2 }))).toBe(true);
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 8 }))).toBe(true);

    // Click on character 1 (left half: x=12, right half: x=18)
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 12 }))).toBe(true);
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 18 }))).toBe(true);
  });

  it("identifies clicks on adjacent unselected characters as outside (half-open [from, to))", () => {
    // doc: "abcdef", selection: [0, 2) ("ab")
    // Character 2 ('c') is unselected and adjacent to the selection boundary
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    // Left half of character 2 ('c') at x=22 (pos=2, assoc=1)
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 22 }))).toBe(false);

    // Right half of character 2 ('c') at x=28 (pos=3, assoc=-1)
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 28 }))).toBe(false);
  });

  it("identifies clicks on unselected characters 3 and 4 on the same line as outside", () => {
    // Task scenario: user selected up to character 2, then presses on character 3/4
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    // Character 3 ('d') at x=35
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 35 }))).toBe(false);

    // Character 4 ('e') at x=45
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 45 }))).toBe(false);
  });

  it("identifies clicks in empty space to the right of the line as outside", () => {
    // doc: "ab" (length 2), selection: [0, 2)
    // Clicking 150px to the right: posAndSideAtCoords clamps to pos=2, assoc=-1 (charPos=1),
    // but coordsForChar shows character 1 ends at x=20. x=150 is outside text bounds.
    const { view } = createMockView({
      doc: "ab",
      selection: EditorSelection.single(0, 2),
    });

    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 150 }))).toBe(false);
  });

  it("does not treat selected newline as draggable text glyph in empty space", () => {
    // doc: "ab\ncd", selection: [0, 3) (includes '\n')
    // Real newline adds a 5px visual marker, but hit test must not treat line 1 empty space as selection
    const { view } = createMockView({
      doc: "ab\ncd",
      selection: EditorSelection.single(0, 3),
    });

    // Character 2 is '\n': coordsForChar returns null, so it is rejected
    view.posAndSideAtCoords = vi.fn(() => ({ pos: 2, assoc: 1 as const }));
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 22 }))).toBe(false);
  });

  it("returns false when coordsForChar returns null for unrendered or non-glyph positions", () => {
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
      charCoordsMap: { 0: null, 1: null },
    });

    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 5 }))).toBe(false);
  });

  it("handles backwards selection correctly (anchor > head)", () => {
    // Selection created backwards: anchor=5, head=2 -> normalized [2, 5)
    const { view } = createMockView({
      doc: "abcdefgh",
      selection: EditorSelection.single(5, 2),
    });

    // Character 1 ('b') at x=15 is outside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 15 }))).toBe(false);

    // Character 2 ('c') at x=25 is inside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 25 }))).toBe(true);

    // Character 4 ('e') at x=45 is inside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 45 }))).toBe(true);

    // Character 5 ('f') at x=55 is outside (exclusive endpoint)
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 55 }))).toBe(false);
  });

  it("returns false when primary selection is empty", () => {
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(2),
    });

    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 10 }))).toBe(false);
  });

  it("only allows primary selection to be draggable when multiple selections exist", () => {
    // Main is [0, 2) ("ab"), secondary is [4, 6) ("ef")
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.create([
        EditorSelection.range(0, 2),
        EditorSelection.range(4, 6),
      ], 0),
    });

    // Inside primary selection [0, 2) -> true
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 5 }))).toBe(true);

    // Inside secondary selection [4, 6) -> false (CodeMirror only drags primary selection)
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 45 }))).toBe(false);

    // Outside both -> false
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 25 }))).toBe(false);
  });

  it.each([
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { detail: 2 },
    { detail: 3 },
    { button: 1 },
    { button: 2 },
  ])("bypasses drag hit-test for modifiers, multi-clicks, and non-left buttons: %j", (overrides) => {
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    // Even when clicking at character 0 (which would be inside for plain single click),
    // modifier or multi-click returns false
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 5, ...overrides }))).toBe(false);
  });

  it("returns false when click target is outside contentDOM (e.g. gutter)", () => {
    const contentDOM = {
      contains: vi.fn(() => false),
    } as unknown as HTMLElement;

    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
      contentDOM,
    });

    const gutterTarget = { nodeType: 1 } as unknown as EventTarget;
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 5, target: gutterTarget }))).toBe(false);
  });

  it("handles CJK full-width characters accurately", () => {
    // doc: "你好世界", selection: [0, 2) ("你好")
    // charWidth = 20
    const { view } = createMockView({
      doc: "你好世界",
      selection: EditorSelection.single(0, 2),
      charWidth: 20,
    });

    // Click on '你' (x=10) -> inside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 10 }))).toBe(true);

    // Click on '好' (x=30) -> inside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 30 }))).toBe(true);

    // Click on '世' (x=50) -> outside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 50 }))).toBe(false);
  });

  it("handles Tab characters accurately with custom layout width", () => {
    // doc: "\thello", selection: [0, 1) ("\t")
    // Tab has width 40, 'h' has width 10 starting at 40
    const { view } = createMockView({
      doc: "\thello",
      selection: EditorSelection.single(0, 1),
      charCoordsMap: {
        0: { left: 0, right: 40, top: 0, bottom: 20 },
        1: { left: 40, right: 50, top: 0, bottom: 20 },
      },
      posSideMap: {
        "20,10": { pos: 0, assoc: 1 },
        "45,10": { pos: 1, assoc: 1 },
      },
    });

    // Click on '\t' (x=20) -> inside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 20 }))).toBe(true);

    // Click on 'h' (x=45) -> outside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 45 }))).toBe(false);
  });

  it("handles emoji surrogate pairs and resolves cluster via findClusterBreak", () => {
    // doc: "a😀b" -> 'a' is [0, 1), '😀' is [1, 3), 'b' is [3, 4)
    // selection is [1, 3) (the emoji 😀)
    const { view } = createMockView({
      doc: "a😀b",
      selection: EditorSelection.single(1, 3),
      charCoordsMap: {
        0: { left: 0, right: 10, top: 0, bottom: 20 },
        1: { left: 10, right: 30, top: 0, bottom: 20 },
        2: null, // surrogate continuation is part of cluster 1
        3: { left: 30, right: 40, top: 0, bottom: 20 },
      },
      posSideMap: {
        "15,10": { pos: 1, assoc: 1 },  // Left half of 😀
        "25,10": { pos: 3, assoc: -1 }, // Right half of 😀 (assoc < 0 points to boundary after 😀)
        "35,10": { pos: 3, assoc: 1 },  // Left half of 'b'
      },
    });

    // Left half of 😀 at x=15 -> inside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 15 }))).toBe(true);

    // Right half of 😀 at x=25 -> inside (findClusterBreak resolves backward from pos 3 to cluster start 1)
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 25 }))).toBe(true);

    // 'b' at x=35 -> outside
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 35 }))).toBe(false);

    // If selection was only [0, 1) ('a'), clicking right half of 😀 at x=25 is outside
    const { view: viewA } = createMockView({
      doc: "a😀b",
      selection: EditorSelection.single(0, 1),
      charCoordsMap: {
        1: { left: 10, right: 30, top: 0, bottom: 20 },
      },
      posSideMap: {
        "25,10": { pos: 3, assoc: -1 },
      },
    });
    expect(isClickInPrimarySelection(viewA as never, createMouseEvent({ clientX: 25 }))).toBe(false);
  });

  it("handles soft-wrapped and bidi character layouts via exact coordsForChar bounding box", () => {
    // doc: "abcdef", selection: [0, 3)
    // Character 2 is soft-wrapped onto visual line 2 (top: 20, bottom: 40, left: 0, right: 10)
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 3),
      charCoordsMap: {
        0: { left: 0, right: 10, top: 0, bottom: 20 },
        1: { left: 10, right: 20, top: 0, bottom: 20 },
        2: { left: 0, right: 10, top: 20, bottom: 40 }, // Wrapped to line 2
      },
      posSideMap: {
        "5,25": { pos: 2, assoc: 1 }, // Click on visual line 2
        "5,5": { pos: 2, assoc: 1 },  // Click on visual line 1 at same X
      },
    });

    // Click at (5, 25) matches char 2's wrapped rect
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 5, clientY: 25 }))).toBe(true);

    // Click at (5, 5) is on line 1, outside char 2's wrapped rect
    expect(isClickInPrimarySelection(view as never, createMouseEvent({ clientX: 5, clientY: 5 }))).toBe(false);
  });
});

describe("handleDragSelectionMousedown top-level handler & DOM guard", () => {
  it("early returns false and does not dispatch when target is outside contentDOM (gutter)", () => {
    const contentDOM = {
      contains: vi.fn(() => false),
    } as unknown as HTMLElement;

    const { view, getState } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
      contentDOM,
    });

    const gutterTarget = { nodeType: 1 } as unknown as EventTarget;
    const event = createMouseEvent({ clientX: 5, target: gutterTarget });

    const result = handleDragSelectionMousedown(event, view as never);
    expect(result).toBe(false);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(2);
  });

  it("early returns false and does not dispatch when target is outside contentDOM (cross-window duck-typing)", () => {
    const contentDOM = {
      contains: vi.fn(() => false),
    } as unknown as HTMLElement;

    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
      contentDOM,
    });

    // Target from another window/realm that fails instanceof Node
    const crossWindowTarget = { externalNodeType: 1 } as unknown as EventTarget;
    const result = handleDragSelectionMousedown(
      createMouseEvent({ clientX: 35, target: crossWindowTarget }),
      view as never,
    );
    expect(result).toBe(false);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("early returns false and does not dispatch when defaultPrevented or non-left-click or modifiers", () => {
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    expect(handleDragSelectionMousedown(createMouseEvent({ defaultPrevented: true, clientX: 35 }), view as never)).toBe(false);
    expect(handleDragSelectionMousedown(createMouseEvent({ button: 1, clientX: 35 }), view as never)).toBe(false);
    expect(handleDragSelectionMousedown(createMouseEvent({ shiftKey: true, clientX: 35 }), view as never)).toBe(false);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("preserves selection untouched on mousedown when clicking inside existing selection", () => {
    // Click inside [0, 2) at character 1 ('b') at x=15
    const { view, getState } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    const event = createMouseEvent({ clientX: 15, clientY: 10 });
    const result = handleDragSelectionMousedown(event, view as never);

    expect(result).toBe(false);

    // Selection was NOT reset: dispatch was not called, preserving native drag-and-drop
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(getState().selection.main.empty).toBe(false);
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(2);
  });

  it("preserves selection untouched when clicking left or right half of selected character", () => {
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    // Left half of character 0 (x=2)
    handleDragSelectionMousedown(createMouseEvent({ clientX: 2 }), view as never);
    expect(view.dispatch).not.toHaveBeenCalled();

    // Right half of character 0 (x=8)
    handleDragSelectionMousedown(createMouseEvent({ clientX: 8 }), view as never);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("resets selection to clicked position on mousedown when clicking characters 3 and 4 on same line", () => {
    // Setup task scenario: selection is [0, 2) ("ab"), click at character 3 ('d')
    const { view, getState } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    expect(getState().selection.main.empty).toBe(false);
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(2);

    // Click at character 3 ('d') at x=32
    const event = createMouseEvent({ clientX: 32, clientY: 10 });
    const result = handleDragSelectionMousedown(event, view as never);

    // Handler returns false so subsequent CodeMirror handlers can run
    expect(result).toBe(false);

    // Selection was reset to a cursor at character 3 (pos=3)
    expect(view.dispatch).toHaveBeenCalledWith({
      selection: EditorSelection.cursor(3, 1),
      userEvent: "select.pointer",
    });
    expect(getState().selection.main.empty).toBe(true);
    expect(getState().selection.main.head).toBe(3);

    // Also verify on fresh selection for character 4 ('e') at x=42
    const { view: view2, getState: getState2 } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });
    handleDragSelectionMousedown(createMouseEvent({ clientX: 42, clientY: 10 }), view2 as never);
    expect(view2.dispatch).toHaveBeenCalledWith({
      selection: EditorSelection.cursor(4, 1),
      userEvent: "select.pointer",
    });
    expect(getState2().selection.main.empty).toBe(true);
    expect(getState2().selection.main.head).toBe(4);
  });

  it("resets selection when clicking adjacent unselected character 2", () => {
    const { view, getState } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0, 2),
    });

    // Click at character 2 ('c') at x=22
    const event = createMouseEvent({ clientX: 22, clientY: 10 });
    handleDragSelectionMousedown(event, view as never);

    expect(view.dispatch).toHaveBeenCalledWith({
      selection: EditorSelection.cursor(2, 1),
      userEvent: "select.pointer",
    });
    expect(getState().selection.main.empty).toBe(true);
    expect(getState().selection.main.head).toBe(2);
  });

  it("resets selection when clicking empty space to the right of the line", () => {
    const { view, getState } = createMockView({
      doc: "ab",
      selection: EditorSelection.single(0, 2),
    });

    // Click 150px to the right of line
    handleDragSelectionMousedown(createMouseEvent({ clientX: 150, clientY: 10 }), view as never);

    expect(view.dispatch).toHaveBeenCalledWith({
      selection: EditorSelection.cursor(2, -1),
      userEvent: "select.pointer",
    });
    expect(getState().selection.main.empty).toBe(true);
  });

  it("does not dispatch when selection is already empty", () => {
    const { view } = createMockView({
      doc: "abcdef",
      selection: EditorSelection.single(0),
    });

    handleDragSelectionMousedown(createMouseEvent({ clientX: 35 }), view as never);
    expect(view.dispatch).not.toHaveBeenCalled();
  });
});

describe("assembly and regression with emptyLineMouseSelectionStyle", () => {
  it("demonstrates real assembly order: old selection is collapsed before emptyLineMouseSelectionStyle activates, allowing upward drag on empty line to incorporate newline", () => {
    // doc: "ab\n\ncd":
    // Line 1: "ab" (0..2), newline at 2
    // Line 2: empty (from: 3, to: 3), newline at 3
    // Line 3: "cd" (from: 4, to: 6)
    // Old selection touches empty line: [0, 3)
    let state = EditorState.create({
      doc: "ab\n\ncd",
      selection: EditorSelection.single(0, 3),
      extensions: [emptyLineMouseSelectionStyle()],
    });

    const mockContentDOM = { contains: () => true } as unknown as HTMLElement;
    const view = {
      get state() { return state; },
      contentDOM: mockContentDOM,
      dispatch: vi.fn((tr: { selection?: EditorSelection }) => {
        if (tr.selection) {
          state = state.update({ selection: tr.selection }).state;
        }
      }),
      posAndSideAtCoords: vi.fn(({ x }: { x: number }) => ({ pos: x, assoc: 1 as const })),
      coordsForChar: vi.fn((pos: number) => {
        // Line 2 at pos 3 is an empty line; coordsForChar returns null
        if (pos === 3 || pos === 2) return null;
        return { left: pos * 10, right: pos * 10 + 10, top: 0, bottom: 20 };
      }),
    };

    // 1. Without handleDragSelectionMousedown, emptyLineMouseSelectionStyle would see
    //    !main.empty && start.pos >= main.from && start.pos <= main.to (3 >= 0 && 3 <= 3)
    //    and would return null!
    const emptyLineFactory = state.facet(EditorView.mouseSelectionStyle)[0];
    const mouseEventAt3 = createMouseEvent({ clientX: 3, clientY: 10 });
    const directResult = emptyLineFactory(view as never, mouseEventAt3);
    expect(directResult).toBeNull();

    // 2. With handleDragSelectionMousedown running on mousedown:
    //    Click at pos 3 is outside primary selection (empty line has no draggable glyph)
    handleDragSelectionMousedown(mouseEventAt3, view as never);

    // Selection was collapsed to cursor(3)
    expect(view.dispatch).toHaveBeenCalledWith({
      selection: EditorSelection.cursor(3, 1),
      userEvent: "select.pointer",
    });
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(3);

    // 3. Now CodeMirror invokes mouseSelectionStyle during mousedown:
    //    Because main is now empty, emptyLineMouseSelectionStyle succeeds and activates
    const activeStyle = emptyLineFactory(view as never, mouseEventAt3);
    expect(activeStyle).not.toBeNull();

    // 4. Dragging upward to pos 1 incorporates the empty line's starting newline at pos 3
    const upwardSelection = activeStyle!.get(createMouseEvent({ clientX: 1, clientY: 10 }), false, false);
    expect(upwardSelection.main.anchor).toBe(4); // anchor is 3 + 1 = 4 (incorporates newline)
    expect(upwardSelection.main.head).toBe(1);
    expect(view.state.sliceDoc(upwardSelection.main.from, upwardSelection.main.to)).toBe("b\n\n");
  });

  it("is bundled into multiCursorMouse() extension suite", () => {
    const extensions = multiCursorMouse();
    expect(Array.isArray(extensions)).toBe(true);

    const hasResetPlugin = (extensions as any[]).some((ext) => {
      const inner = ext?.inner ?? ext?.value ?? ext;
      return (
        inner?.domEventHandlers?.mousedown === handleDragSelectionMousedown
      );
    });
    expect(hasResetPlugin).toBe(true);
  });
});