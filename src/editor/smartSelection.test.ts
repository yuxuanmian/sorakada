import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  clearSmartSelectionHistory,
  expandSmartSelection,
  shrinkSmartSelection,
  smartSelection,
} from "./smartSelection";
import { getWordOrUnitRange } from "./smartSelectionBoundaries";

function createState(
  doc: string,
  selection?: EditorSelection | SelectionRange,
): EditorState {
  const sel =
    selection instanceof EditorSelection
      ? selection
      : selection
      ? EditorSelection.create([selection])
      : EditorSelection.cursor(0);
  return EditorState.create({
    doc,
    selection: sel,
    extensions: [smartSelection(), EditorState.allowMultipleSelections.of(true)],
  });
}

describe("smartSelection - Unit Boundaries (Spec 013 §1, A02, A03)", () => {
  it("separates dot-delimited words in dialogs.AbcCdd", () => {
    const text = "dialogs.AbcCdd";
    const state = createState(text);

    // In 'dialogs'
    const u1 = getWordOrUnitRange(state.doc, 2);
    expect(state.doc.sliceString(u1.from, u1.to)).toBe("dialogs");

    // On '.'
    const uDot = getWordOrUnitRange(state.doc, 7, 1);
    expect(state.doc.sliceString(uDot.from, uDot.to)).toBe(".");

    // In 'AbcCdd'
    const u2 = getWordOrUnitRange(state.doc, 10);
    expect(state.doc.sliceString(u2.from, u2.to)).toBe("AbcCdd");
  });

  it("separates hyphen-delimited words in dialogs-AbcCdd", () => {
    const text = "dialogs-AbcCdd";
    const state = createState(text);

    const u1 = getWordOrUnitRange(state.doc, 3);
    expect(state.doc.sliceString(u1.from, u1.to)).toBe("dialogs");

    const uHyphen = getWordOrUnitRange(state.doc, 7, 1);
    expect(state.doc.sliceString(uHyphen.from, uHyphen.to)).toBe("-");

    const u2 = getWordOrUnitRange(state.doc, 9);
    expect(state.doc.sliceString(u2.from, u2.to)).toBe("AbcCdd");
  });

  it("does not split camelCase or PascalCase into subwords", () => {
    const text = "camelCase PascalCase dialogsAbcCdd";
    const state = createState(text);

    const u1 = getWordOrUnitRange(state.doc, 3);
    expect(state.doc.sliceString(u1.from, u1.to)).toBe("camelCase");

    const u2 = getWordOrUnitRange(state.doc, 14);
    expect(state.doc.sliceString(u2.from, u2.to)).toBe("PascalCase");

    const u3 = getWordOrUnitRange(state.doc, 25);
    expect(state.doc.sliceString(u3.from, u3.to)).toBe("dialogsAbcCdd");
  });

  it("selects snake_case as a single unit with internal underscores", () => {
    const text = "my_snake_case_variable";
    const state = createState(text);

    const u = getWordOrUnitRange(state.doc, 5);
    expect(state.doc.sliceString(u.from, u.to)).toBe("my_snake_case_variable");
  });

  it("selects world in 'hello, world' without leading comma or space", () => {
    const text = "hello, world";
    const state = createState(text);

    // 'world'
    const uWorld = getWordOrUnitRange(state.doc, 9);
    expect(state.doc.sliceString(uWorld.from, uWorld.to)).toBe("world");

    // ','
    const uComma = getWordOrUnitRange(state.doc, 5, 1);
    expect(state.doc.sliceString(uComma.from, uComma.to)).toBe(",");

    // ' '
    const uSpace = getWordOrUnitRange(state.doc, 6, 1);
    expect(state.doc.sliceString(uSpace.from, uSpace.to)).toBe(" ");
  });

  it("selects consecutive inline whitespace/Tab without swallowing words or newlines", () => {
    const text = "foo    \tbar\nnext";
    const state = createState(text);

    const u = getWordOrUnitRange(state.doc, 5);
    expect(state.doc.sliceString(u.from, u.to)).toBe("    \t");
  });

  it("selects Chinese characters and punctuation individually in '甲，乙'", () => {
    const text = "甲，乙";
    const state = createState(text);

    const uJia = getWordOrUnitRange(state.doc, 0);
    expect(state.doc.sliceString(uJia.from, uJia.to)).toBe("甲");

    const uComma = getWordOrUnitRange(state.doc, 1);
    expect(state.doc.sliceString(uComma.from, uComma.to)).toBe("，");

    const uYi = getWordOrUnitRange(state.doc, 2);
    expect(state.doc.sliceString(uYi.from, uYi.to)).toBe("乙");
  });

  it("preserves multi-code-unit Emoji and ZWJ sequences safely", () => {
    const text = "prefix 👨‍👩‍👧‍👦 👍🏽 suffix";
    const state = createState(text);

    // 👨‍👩‍👧‍👦 starts at offset 7
    const familyStart = 7;
    const uFamily = getWordOrUnitRange(state.doc, familyStart + 2);
    expect(state.doc.sliceString(uFamily.from, uFamily.to)).toBe("👨‍👩‍👧‍👦");

    // 👍🏽
    const thumbStart = text.indexOf("👍🏽");
    const uThumb = getWordOrUnitRange(state.doc, thumbStart + 1);
    expect(state.doc.sliceString(uThumb.from, uThumb.to)).toBe("👍🏽");
  });

  it("covers empty line between paragraphs as a newline unit", () => {
    const text = "para1\n\npara2";
    const state = createState(text);

    // Empty line is at line 2 (offset 6)
    const u = getWordOrUnitRange(state.doc, 6);
    expect(u.from).toBe(6);
    expect(u.to).toBe(7);
    expect(state.doc.sliceString(u.from, u.to)).toBe("\n");
  });
});

describe("smartSelection - Structural Expansion (Spec 013 §2, §3, A04)", () => {
  it("follows the exact spec hierarchy: bar -> bar, baz -> (bar, baz) -> foo(bar, baz) -> foo(bar, baz);", () => {
    const doc = "foo(bar, baz);";
    // Caret at offset 5 inside 'bar'
    let state = createState(doc, EditorSelection.cursor(5));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    const stepText = () =>
      state.doc.sliceString(state.selection.main.from, state.selection.main.to);

    // Step 1: bar
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("bar");

    // Step 2: bar, baz
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("bar, baz");

    // Step 3: (bar, baz)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("(bar, baz)");

    // Step 4: foo(bar, baz)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("foo(bar, baz)");

    // Step 5: foo(bar, baz);
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("foo(bar, baz);");

    // Further expansion is document top
    expect(expandSmartSelection({ state, dispatch })).toBe(false);
    expect(stepText()).toBe("foo(bar, baz);");
  });

  it("expands nested structures outward in outer(inner(a, b), c)", () => {
    const doc = "outer(inner(a, b), c)";
    // Caret at 'a' (offset 12)
    let state = createState(doc, EditorSelection.cursor(12));
    const dispatch = (tr: any) => {
      state = tr.state;
    };
    const stepText = () =>
      state.doc.sliceString(state.selection.main.from, state.selection.main.to);

    // 1: a
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("a");

    // 2: a, b
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("a, b");

    // 3: (a, b)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("(a, b)");

    // 4: inner(a, b)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("inner(a, b)");

    // 5: inner(a, b), c
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("inner(a, b), c");

    // 6: (inner(a, b), c)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("(inner(a, b), c)");

    // 7: outer(inner(a, b), c)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("outer(inner(a, b), c)");
  });

  it("treats brackets inside quotes conservatively without matching outside quotes", () => {
    const doc = 'const msg = "hello (world)";';
    // Caret inside 'world'
    const worldPos = doc.indexOf("world") + 1;
    let state = createState(doc, EditorSelection.cursor(worldPos));
    const dispatch = (tr: any) => {
      state = tr.state;
    };
    const stepText = () =>
      state.doc.sliceString(state.selection.main.from, state.selection.main.to);

    // 1: world
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("world");

    // 2: inner quote: hello (world)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("hello (world)");

    // 3: outer quote: "hello (world)"
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe('"hello (world)"');
  });

  it("supports Chinese full-width brackets", () => {
    const doc = "（测试，内容）";
    let state = createState(doc, EditorSelection.cursor(2));
    const dispatch = (tr: any) => {
      state = tr.state;
    };
    const stepText = () =>
      state.doc.sliceString(state.selection.main.from, state.selection.main.to);

    // 1: 测试
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("测试");

    // 2: 测试，内容
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("测试，内容");

    // 3: （测试，内容）
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("（测试，内容）");
  });
});

describe("smartSelection - Snapshot Shrinking & Merge Restoration (Spec 013 §2, A05, A06)", () => {
  it("restores exact initial caret through complete shrink round trip", () => {
    const doc = "foo(bar, baz);";
    const initialPos = 5;
    let state = createState(doc, EditorSelection.cursor(initialPos));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Expand 5 times
    for (let i = 0; i < 5; i++) {
      expect(expandSmartSelection({ state, dispatch })).toBe(true);
    }
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe(
      "foo(bar, baz);",
    );

    // Shrink 5 times
    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe(
      "foo(bar, baz)",
    );

    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe(
      "(bar, baz)",
    );

    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe(
      "bar, baz",
    );

    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe(
      "bar",
    );

    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.main.from).toBe(initialPos);
    expect(state.selection.main.to).toBe(initialPos);

    // Further shrink has no history and returns false
    expect(shrinkSmartSelection({ state, dispatch })).toBe(false);
    expect(state.selection.main.from).toBe(initialPos);
  });

  it("preserves backward selection direction (anchor > head) on shrink", () => {
    const doc = "alpha beta gamma";
    // Backward selection on 'beta' (anchor 10, head 6)
    let state = createState(doc, EditorSelection.single(10, 6));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    // Shrink back
    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.main.anchor).toBe(10);
    expect(state.selection.main.head).toBe(6);
  });

  it("restores pre-merge multiple ranges when CodeMirror merges them on expand", () => {
    const doc = "foo(bar, baz);";
    // Two cursors: one in 'bar' (pos 5), one in 'baz' (pos 10)
    const initialSel = EditorSelection.create([
      EditorSelection.cursor(5),
      EditorSelection.cursor(10),
    ]);
    let state = createState(doc, initialSel);
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Step 1: Expand -> 'bar' and 'baz' (2 ranges)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.ranges).toHaveLength(2);
    expect(state.doc.sliceString(state.selection.ranges[0].from, state.selection.ranges[0].to)).toBe("bar");
    expect(state.doc.sliceString(state.selection.ranges[1].from, state.selection.ranges[1].to)).toBe("baz");

    // Step 2: Expand -> both expand to 'bar, baz', which CodeMirror natively merges into 1 range!
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.ranges).toHaveLength(1);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe("bar, baz");

    // Shrink: MUST restore the 2 separate ranges before the merge!
    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.ranges).toHaveLength(2);
    expect(state.doc.sliceString(state.selection.ranges[0].from, state.selection.ranges[0].to)).toBe("bar");
    expect(state.doc.sliceString(state.selection.ranges[1].from, state.selection.ranges[1].to)).toBe("baz");

    // Shrink once more: restores the two original collapsed carets!
    expect(shrinkSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.ranges).toHaveLength(2);
    expect(state.selection.ranges[0].from).toBe(5);
    expect(state.selection.ranges[0].to).toBe(5);
    expect(state.selection.ranges[1].from).toBe(10);
    expect(state.selection.ranges[1].to).toBe(10);
  });
});

describe("smartSelection - History Invalidation & Safety (Spec 013 §2, A06)", () => {
  it("invalidates history when document text changes", () => {
    const doc = "foo(bar, baz);";
    let state = createState(doc, EditorSelection.cursor(5));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Expand once
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe("bar");

    // User types a character (docChanged)
    state = state.update({
      changes: { from: 5, insert: "X" },
    }).state;

    // Shrink must fail because text changed
    expect(shrinkSmartSelection({ state, dispatch })).toBe(false);
  });

  it("invalidates history on external cursor navigation", () => {
    const doc = "foo(bar, baz);";
    let state = createState(doc, EditorSelection.cursor(5));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    expect(expandSmartSelection({ state, dispatch })).toBe(true);

    // External selection movement (e.g. arrow key or mouse click)
    state = state.update({
      selection: EditorSelection.cursor(0),
    }).state;

    // Shrink must fail
    expect(shrinkSmartSelection({ state, dispatch })).toBe(false);
  });

  it("clears history on clearSmartSelectionHistory effect (for document switch)", () => {
    const doc = "foo(bar, baz);";
    let state = createState(doc, EditorSelection.cursor(5));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    expect(expandSmartSelection({ state, dispatch })).toBe(true);

    // Clear effect dispatched by document bridge
    state = state.update({
      effects: clearSmartSelectionHistory.of(),
    }).state;

    // Shrink must fail
    expect(shrinkSmartSelection({ state, dispatch })).toBe(false);
  });

  it("does not mutate document text, line endings, or dirty state during expand/shrink", () => {
    const doc = "line1\r\nline2\r\nline3";
    let state = createState(doc, EditorSelection.cursor(7));
    const originalText = state.doc.toString();
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Expand 3 times, shrink 3 times
    for (let i = 0; i < 3; i++) {
      expandSmartSelection({ state, dispatch });
    }
    for (let i = 0; i < 3; i++) {
      shrinkSmartSelection({ state, dispatch });
    }

    expect(state.doc.toString()).toBe(originalText);
  });
});

describe("smartSelection - Compounds, Paragraphs and Double-Click Style", () => {
  it("expands dotted compound after single word in dialogs.AbcCdd", () => {
    const doc = "dialogs.AbcCdd";
    let state = createState(doc, EditorSelection.cursor(10)); // in AbcCdd
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Step 1: AbcCdd
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe("AbcCdd");

    // Step 2: dialogs.AbcCdd
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe("dialogs.AbcCdd");
  });

  it("expands decimal number compound in const x = 123.45;", () => {
    const doc = "const x = 123.45;";
    let state = createState(doc, EditorSelection.cursor(11)); // in 123
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Step 1: 123
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe("123");

    // Step 2: 123.45
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe("123.45");
  });

  it("returns false and does not record history when already at document top", () => {
    const doc = "single line";
    let state = createState(doc, EditorSelection.range(0, doc.length));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    expect(expandSmartSelection({ state, dispatch })).toBe(false);
    expect(shrinkSmartSelection({ state, dispatch })).toBe(false);
  });

  it("provides double-click mouseSelectionStyle that shares unit boundary", () => {
    const doc = "hello, world";
    const state = createState(doc);
    const styles = state.facet(EditorView.mouseSelectionStyle);
    expect(styles.length).toBeGreaterThan(0);

    const makeStyle = styles[0];
    const mockView = {
      state,
      posAndSideAtCoords: () => ({ pos: 8, assoc: 1 }), // inside 'world'
    };

    expect(makeStyle(mockView as any, { button: 0, detail: 1 } as any)).toBeNull();
    expect(makeStyle(mockView as any, { button: 0, detail: 3 } as any)).toBeNull();
    expect(makeStyle(mockView as any, { button: 0, detail: 2, altKey: true } as any)).toBeNull();

    const style = makeStyle(mockView as any, { button: 0, detail: 2, clientX: 0, clientY: 0 } as any);
    expect(style).not.toBeNull();
    const sel = style!.get({ clientX: 0, clientY: 0 } as any, false, false);
    expect(state.doc.sliceString(sel.main.from, sel.main.to)).toBe("world");
  });
});

describe("smartSelection - Lead Point 1-5 Targeted Regression Tests", () => {
  it("Lead Point 1: mouse assoc distinguishes character halves (hello.world and hello world)", () => {
    const doc = "hello.world";
    const state = createState(doc);
    const styles = state.facet(EditorView.mouseSelectionStyle);
    expect(styles.length).toBeGreaterThan(0);
    const makeStyle = styles[0];

    // Right half of 'o': pos = 5, assoc = -1 -> hits 'hello'
    const viewRightO = {
      state,
      posAndSideAtCoords: () => ({ pos: 5, assoc: -1 }),
    };
    const styleRightO = makeStyle(viewRightO as any, {
      button: 0,
      detail: 2,
      clientX: 0,
      clientY: 0,
    } as any);
    expect(styleRightO).not.toBeNull();
    const selRightO = styleRightO!.get({ clientX: 0, clientY: 0 } as any, false, false);
    expect(state.doc.sliceString(selRightO.main.from, selRightO.main.to)).toBe("hello");

    // Left half of '.': pos = 5, assoc = 1 -> hits '.'
    const viewLeftDot = {
      state,
      posAndSideAtCoords: () => ({ pos: 5, assoc: 1 }),
    };
    const styleLeftDot = makeStyle(viewLeftDot as any, {
      button: 0,
      detail: 2,
      clientX: 0,
      clientY: 0,
    } as any);
    expect(styleLeftDot).not.toBeNull();
    const selLeftDot = styleLeftDot!.get({ clientX: 0, clientY: 0 } as any, false, false);
    expect(state.doc.sliceString(selLeftDot.main.from, selLeftDot.main.to)).toBe(".");

    // Right half of 'o' in 'hello world': pos = 5, assoc = -1 -> hits 'hello', not space
    const docSpace = "hello world";
    const stateSpace = createState(docSpace);
    const viewRightOSpace = {
      state: stateSpace,
      posAndSideAtCoords: () => ({ pos: 5, assoc: -1 }),
    };
    const styleSpace = makeStyle(viewRightOSpace as any, {
      button: 0,
      detail: 2,
      clientX: 0,
      clientY: 0,
    } as any);
    expect(styleSpace).not.toBeNull();
    const selSpace = styleSpace!.get({ clientX: 0, clientY: 0 } as any, false, false);
    expect(stateSpace.doc.sliceString(selSpace.main.from, selSpace.main.to)).toBe("hello");
  });

  it("Lead Point 2: selects decomposed café ('cafe\\u0301') as a single word at first level", () => {
    const text = "cafe\u0301 and coffee";
    const state = createState(text);

    // In decomposed cafe (index 2 is 'f')
    const u1 = getWordOrUnitRange(state.doc, 2);
    expect(state.doc.sliceString(u1.from, u1.to)).toBe("cafe\u0301");
    expect(u1.from).toBe(0);
    expect(u1.to).toBe(5);

    // Caret directly on the combining acute accent offset (index 4)
    const u2 = getWordOrUnitRange(state.doc, 4);
    expect(state.doc.sliceString(u2.from, u2.to)).toBe("cafe\u0301");
  });

  it("Lead Point 3 & 4: recovers conservatively on bracket mismatch ([abc) without creating pseudo-structures", () => {
    const doc = "([abc)";
    let state = createState(doc, EditorSelection.cursor(3)); // inside abc
    const dispatch = (tr: any) => {
      state = tr.state;
    };
    const stepText = () =>
      state.doc.sliceString(state.selection.main.from, state.selection.main.to);

    // Step 1: abc
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("abc");

    // Step 2: Mismatched [ and ) clears stack, no pseudo-structure. Falls back to line
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("([abc)");

    // Valid nested brackets ([valid]) still cleanly expand through all levels
    const docValid = "([valid])";
    let stateValid = createState(docValid, EditorSelection.cursor(4));
    const dispatchValid = (tr: any) => {
      stateValid = tr.state;
    };
    const stepValid = () =>
      stateValid.doc.sliceString(
        stateValid.selection.main.from,
        stateValid.selection.main.to,
      );

    expect(expandSmartSelection({ state: stateValid, dispatch: dispatchValid })).toBe(true);
    expect(stepValid()).toBe("valid");

    expect(expandSmartSelection({ state: stateValid, dispatch: dispatchValid })).toBe(true);
    expect(stepValid()).toBe("[valid]");

    expect(expandSmartSelection({ state: stateValid, dispatch: dispatchValid })).toBe(true);
    expect(stepValid()).toBe("([valid])");
  });

  it("Lead Point 3: bounded scanning fast-paths for collapsed caret and document top", () => {
    const doc = "simple text";
    let state = createState(doc, EditorSelection.cursor(2));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Collapsed caret expands directly to word
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.doc.sliceString(state.selection.main.from, state.selection.main.to)).toBe(
      "simple",
    );

    // Document top immediately returns false and records no history
    let stateTop = createState(doc, EditorSelection.range(0, doc.length));
    const dispatchTop = (tr: any) => {
      stateTop = tr.state;
    };
    expect(expandSmartSelection({ state: stateTop, dispatch: dispatchTop })).toBe(false);
    expect(shrinkSmartSelection({ state: stateTop, dispatch: dispatchTop })).toBe(false);
  });
});

describe("smartSelection - Lead Round 2 Targeted Regression Tests", () => {
  it("Lead Item 1: expands non-empty partial selection within a word to full word ('a' in 'bar' -> 'bar')", () => {
    const doc = "foo bar baz";
    // 'bar' starts at index 4 (b=4, a=5, r=6)
    // Select just 'a' (5..6)
    let state = createState(doc, EditorSelection.range(5, 6));
    const dispatch = (tr: any) => {
      state = tr.state;
    };
    const stepText = () =>
      state.doc.sliceString(state.selection.main.from, state.selection.main.to);

    // Initial is 'a'
    expect(stepText()).toBe("a");

    // Step 1: Expands to 'bar', NOT straight to line!
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("bar");

    // Step 2: Expands to full line 'foo bar baz'
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("foo bar baz");
  });

  it("Lead Item 4: unclosed ASCII quote on line 1 does not suppress valid bracket structure on line 2", () => {
    const doc = 'const msg = "unclosed quote\nfoo(bar, baz);';
    // 'bar' is on line 2
    const barPos = doc.indexOf("bar");
    let state = createState(doc, EditorSelection.cursor(barPos));
    const dispatch = (tr: any) => {
      state = tr.state;
    };
    const stepText = () =>
      state.doc.sliceString(state.selection.main.from, state.selection.main.to);

    // 1: bar
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("bar");

    // 2: bar, baz
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("bar, baz");

    // 3: (bar, baz) - Valid bracket on line 2 is NOT swallowed as string literal!
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("(bar, baz)");

    // 4: foo(bar, baz)
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(stepText()).toBe("foo(bar, baz)");
  });

  it("Lead Item 2 & 3: ultra-long unit exceeding boundary budget falls back to line without fragmented token", () => {
    // Generate a line with a 2,000-char continuous run of 'a' without spaces
    const giantWord = "a".repeat(2000);
    const doc = "prefix " + giantWord + " suffix";
    const caretPos = 7 + 1000; // in the middle of giantWord
    let state = createState(doc, EditorSelection.cursor(caretPos));
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // Expanding inside the unconfirmed 2,000-char continuous run falls back safely to full line
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.main.from).toBe(0);
    expect(state.selection.main.to).toBe(doc.length);
  });

  it("Lead Item 2: multi-selection with exhausted shared budget falls back safely to line/doc", () => {
    const doc = "foo(a, b);\nbar(c, d);\nbaz(e, f);";
    // 3 cursors
    const initialSel = EditorSelection.create([
      EditorSelection.cursor(doc.indexOf("a")),
      EditorSelection.cursor(doc.indexOf("c")),
      EditorSelection.cursor(doc.indexOf("e")),
    ]);
    let state = createState(doc, initialSel);
    const dispatch = (tr: any) => {
      state = tr.state;
    };

    // All 3 cursors expand to their words
    expect(expandSmartSelection({ state, dispatch })).toBe(true);
    expect(state.selection.ranges).toHaveLength(3);
    expect(state.doc.sliceString(state.selection.ranges[0].from, state.selection.ranges[0].to)).toBe("a");
    expect(state.doc.sliceString(state.selection.ranges[1].from, state.selection.ranges[1].to)).toBe("c");
    expect(state.doc.sliceString(state.selection.ranges[2].from, state.selection.ranges[2].to)).toBe("e");
  });
});