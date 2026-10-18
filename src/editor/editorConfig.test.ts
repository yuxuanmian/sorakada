import { describe, expect, it } from "vitest";
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from "@codemirror/state";
import {
  indentLess,
  redo,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { editorLanguageFacet } from "./editorLanguage";

import { createEditorState, createExternalReloadState } from "./editorConfig";

/**
 * Tests for the external-reload state factory (005, FR-018, FR-019).
 *
 * The factory is where "a disk reload is not a user edit" is decided, so these
 * tests pin the three properties the specification requires of it. Bringing the
 * clamped primary head into view belongs to the view bridge
 * (`EditorHandle.reloadDocumentState`) and is covered through the manager's fake
 * bridge; a real `EditorView` needs a DOM, and 005 deliberately does not add a
 * component-test harness (see T050 in `tasks.md`).
 */
describe("createExternalReloadState", () => {
  it("clears undo/redo history so undo cannot resurrect the superseded version", () => {
    const initial = createEditorState("alpha");
    // A real user edit, which is exactly what makes an undoable transaction.
    const edited = initial.update({
      changes: { from: 5, insert: " beta" },
    }).state;
    expect(undoDepth(edited)).toBe(1);

    const reloaded = createExternalReloadState(edited, "gamma");

    expect(reloaded.doc.toString()).toBe("gamma");
    expect(undoDepth(reloaded)).toBe(0);
  });

  it("keeps every selection anchor and head at the same absolute offset", () => {
    const state = createEditorState("0123456789");
    const selected = state.update({
      selection: EditorSelection.single(3, 7),
    }).state;

    const reloaded = createExternalReloadState(selected, "0123456789");

    expect(reloaded.selection.main.anchor).toBe(3);
    expect(reloaded.selection.main.head).toBe(7);
    expect(undoDepth(reloaded)).toBe(0);
  });

  it("clamps offsets past the new document length instead of failing the reload", () => {
    const state = createEditorState("0123456789");
    const selected = state.update({
      selection: EditorSelection.single(3, 9),
    }).state;

    const reloaded = createExternalReloadState(selected, "01234");

    expect(reloaded.doc.length).toBe(5);
    expect(reloaded.selection.main.anchor).toBe(3);
    expect(reloaded.selection.main.head).toBe(5);
  });

  it("preserves every range of a multi-selection and keeps the primary range primary", () => {
    const state = createEditorState("0123456789");
    const selected = state.update({
      selection: EditorSelection.create(
        [EditorSelection.range(1, 2), EditorSelection.range(8, 9)],
        1,
      ),
    }).state;

    const reloaded = createExternalReloadState(selected, "012345");

    expect(
      reloaded.selection.ranges.map((range) => [range.anchor, range.head]),
    ).toEqual([
      [1, 2],
      [6, 6],
    ]);
    expect(reloaded.selection.mainIndex).toBe(1);
  });

  it("collapses a clamped selection onto the end of an empty replacement", () => {
    const state = createEditorState("0123456789");
    const selected = state.update({
      selection: EditorSelection.single(4, 9),
    }).state;

    const reloaded = createExternalReloadState(selected, "");

    expect(reloaded.doc.length).toBe(0);
    expect(reloaded.selection.main.anchor).toBe(0);
    expect(reloaded.selection.main.head).toBe(0);
  });

  it("installs the application extensions so the reloaded state keeps receiving updates", () => {
    const runtime = EditorState.tabSize.of(7);
    const state = createEditorState("alpha", runtime);

    const reloaded = createExternalReloadState(state, "beta", runtime);

    expect(reloaded.doc.toString()).toBe("beta");
    // The factory is the same one `DocumentManager` opens documents through, so a
    // reloaded state carries the runtime extensions (the editor bridge's update
    // listener) and the appearance boundary as well.
    expect(reloaded.facet(EditorState.tabSize)).toBe(7);
    expect(undoDepth(reloaded)).toBe(0);
  });
});

describe("createEditorState language configuration (014)", () => {
  it("initializes plain text metadata when filename is null or omitted", () => {
    const stateDefault = createEditorState("hello");
    expect(stateDefault.facet(editorLanguageFacet)).toEqual({
      filename: null,
      name: null,
      loaded: false,
    });

    const stateExplicitNull = createEditorState("hello", [], null);
    expect(stateExplicitNull.facet(editorLanguageFacet)).toEqual({
      filename: null,
      name: null,
      loaded: false,
    });
  });

  it("initializes recognized language metadata for known extension or path", () => {
    const stateTs = createEditorState("const x = 1;", [], "index.ts");
    expect(stateTs.facet(editorLanguageFacet).filename).toBe("index.ts");
    expect(stateTs.facet(editorLanguageFacet).name).toBe("TypeScript");

    const statePy = createEditorState("x = 1", [], "C:\\project\\main.py");
    expect(statePy.facet(editorLanguageFacet).filename).toBe(
      "C:\\project\\main.py",
    );
    expect(statePy.facet(editorLanguageFacet).name).toBe("Python");
  });

  it("initializes plain text metadata for unrecognized extension", () => {
    const stateUnknown = createEditorState(
      "data",
      [],
      "file.unrecognized_ext_123",
    );
    expect(stateUnknown.facet(editorLanguageFacet)).toEqual({
      filename: "file.unrecognized_ext_123",
      name: null,
      loaded: false,
    });
  });
});

describe("createExternalReloadState language preservation (014)", () => {
  it("preserves language metadata from current state when filename is omitted", () => {
    const initial = createEditorState("const x = 1;", [], "app.ts");
    expect(initial.facet(editorLanguageFacet).name).toBe("TypeScript");

    const reloaded = createExternalReloadState(initial, "const x = 2;");
    expect(reloaded.facet(editorLanguageFacet).filename).toBe("app.ts");
    expect(reloaded.facet(editorLanguageFacet).name).toBe("TypeScript");
    expect(reloaded.doc.toString()).toBe("const x = 2;");
  });

  it("applies new language metadata when an explicit filename is supplied", () => {
    const initial = createEditorState("const x = 1;", [], "app.ts");
    expect(initial.facet(editorLanguageFacet).name).toBe("TypeScript");

    const reloaded = createExternalReloadState(
      initial,
      "print(2)",
      [],
      "script.py",
    );
    expect(reloaded.facet(editorLanguageFacet).filename).toBe("script.py");
    expect(reloaded.facet(editorLanguageFacet).name).toBe("Python");
    expect(reloaded.doc.toString()).toBe("print(2)");
  });
});

/**
 * Lightweight harness that executes keymap commands directly against an
 * EditorState and updates the current state via dispatch (014 A04).
 */
function createDispatchHarness(initialState: EditorState) {
  let state = initialState;
  let lastTransaction: Transaction | null = null;
  const dispatch = (tr: Transaction) => {
    lastTransaction = tr;
    state = tr.state;
  };
  const getTabBinding = () =>
    state
      .facet(keymap)
      .flat()
      .find((binding) => binding.key === "Tab");

  return {
    getState: () => state,
    getLastTransaction: () => lastTransaction,
    pressTab: () => {
      const binding = getTabBinding();
      return binding?.run
        ? binding.run({ state, dispatch } as unknown as EditorView)
        : false;
    },
    pressShiftTab: () => {
      const binding = getTabBinding();
      return binding?.shift
        ? binding.shift({ state, dispatch } as unknown as EditorView)
        : false;
    },
    undo: () => undo({ state, dispatch }),
    redo: () => redo({ state, dispatch }),
  };
}

describe("createEditorState Tab indentation keymap (014)", () => {
  it("binds Tab insertion and native Shift+Tab with default focus prevention", () => {
    const state = createEditorState("alpha");
    const tabBindings = state
      .facet(keymap)
      .flat()
      .filter((binding) => binding.key === "Tab");

    expect(tabBindings.length).toBe(1);
    expect(tabBindings[0].run).toBeTypeOf("function");
    expect(tabBindings[0].shift).toBe(indentLess);
    expect(tabBindings[0].preventDefault).toBe(true);
  });

  it("inserts two spaces at an inline caret with undo/redo and unindents natively", () => {
    const initial = createEditorState("alpha").update({
      selection: EditorSelection.cursor(1),
    }).state;
    const harness = createDispatchHarness(initial);

    expect(harness.pressTab()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("a  lpha");
    expect(harness.getState().selection.main.head).toBe(3);
    expect(harness.getLastTransaction()?.isUserEvent("input")).toBe(true);
    expect(harness.getLastTransaction()?.scrollIntoView).toBe(true);
    expect(harness.undo()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("alpha");
    expect(harness.redo()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("a  lpha");
    expect(harness.getState().selection.main.head).toBe(3);

    const indented = createEditorState("  alpha").update({
      selection: EditorSelection.cursor(5),
    }).state;
    const unindentHarness = createDispatchHarness(indented);

    expect(unindentHarness.pressShiftTab()).toBe(true);
    expect(unindentHarness.getState().doc.toString()).toBe("alpha");
    expect(unindentHarness.undo()).toBe(true);
    expect(unindentHarness.getState().doc.toString()).toBe("  alpha");
  });

  it("indents and unindents all lines covered by a multi-line selection", () => {
    const initial = createEditorState("line1\nline2\nline3").update({
      selection: EditorSelection.range(2, 8),
    }).state;
    const harness = createDispatchHarness(initial);

    expect(harness.pressTab()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("  line1\n  line2\nline3");
    expect(harness.undo()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("line1\nline2\nline3");

    const indented = createEditorState("  line1\n  line2\nline3").update({
      selection: EditorSelection.range(4, 12),
    }).state;
    const unindentHarness = createDispatchHarness(indented);

    expect(unindentHarness.pressShiftTab()).toBe(true);
    expect(unindentHarness.getState().doc.toString()).toBe("line1\nline2\nline3");
    expect(unindentHarness.undo()).toBe(true);
    expect(unindentHarness.getState().doc.toString()).toBe("  line1\n  line2\nline3");
  });

  it("inserts independently at every caret, including on the same line, preserving the main range", () => {
    const initial = createEditorState("line1\nline2\nline3").update({
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(3),
        EditorSelection.cursor(13),
      ], 1),
    }).state;
    const harness = createDispatchHarness(initial);

    expect(harness.pressTab()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("l  in  e1\nline2\nl  ine3");
    expect(harness.getState().selection.ranges.map((range) => range.head)).toEqual([3, 7, 19]);
    expect(harness.getState().selection.mainIndex).toBe(1);
    expect(harness.undo()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("line1\nline2\nline3");
    expect(harness.redo()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("l  in  e1\nline2\nl  ine3");
    expect(harness.getState().selection.mainIndex).toBe(1);

    const indented = createEditorState("  line1\nline2\n  line3").update({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(16),
      ]),
    }).state;
    const unindentHarness = createDispatchHarness(indented);

    expect(unindentHarness.pressShiftTab()).toBe(true);
    expect(unindentHarness.getState().doc.toString()).toBe("line1\nline2\nline3");
    expect(unindentHarness.undo()).toBe(true);
    expect(unindentHarness.getState().doc.toString()).toBe("  line1\nline2\n  line3");
  });

  it("uses block indentation if any range is non-empty, even with a primary caret", () => {
    const initial = createEditorState("alpha\nbeta").update({
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.range(6, 10),
      ], 0),
    }).state;
    const harness = createDispatchHarness(initial);

    expect(harness.pressTab()).toBe(true);
    expect(harness.getState().doc.toString()).toBe("  alpha\n  beta");
    expect(harness.getState().selection.mainIndex).toBe(0);
    expect(harness.getState().selection.ranges.map((range) => [range.anchor, range.head])).toEqual([
      [3, 3], [10, 14],
    ]);
  });

  it("does not dispatch edits for read-only carets or ranges on Tab or Shift+Tab", () => {
    const initial = createEditorState("  alpha", EditorState.readOnly.of(true));
    for (const selection of [EditorSelection.single(3), EditorSelection.single(2, 5)]) {
      const selected = initial.update({ selection }).state;
      const harness = createDispatchHarness(selected);

      expect(harness.pressTab()).toBe(false);
      expect(harness.pressShiftTab()).toBe(false);
      expect(harness.getState()).toBe(selected);
      expect(harness.getLastTransaction()).toBeNull();
      expect(undoDepth(harness.getState())).toBe(0);
    }
  });
});
