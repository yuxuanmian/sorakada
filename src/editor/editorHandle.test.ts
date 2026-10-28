import { describe, expect, it } from "vitest";
import { undo, undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { createEditorState } from "./editorConfig";
import { createEditorHandle, type EditorHandle } from "./editorHandle";
import { editorLanguageFacet } from "./editorLanguage";
import { smartSelectionHistoryField } from "./smartSelection";

interface TestBridge {
  handle: EditorHandle;
  getState: () => EditorState;
  dispatchEdit: (from: number, to: number, insert: string) => void;
  dispatchSelection: (anchor: number, head?: number) => void;
  dispatchedEffects: any[];
  view: {
    state: EditorState;
    dispatch: (tr: {
      changes?: unknown;
      selection?: unknown;
      effects?: unknown;
      annotations?: unknown;
      userEvent?: string;
      state?: EditorState;
    }) => void;
    focus: () => void;
    setState: (newState: EditorState) => void;
  };
}

function createTestBridge(initialDoc = "", readOnly = false): TestBridge {
  const extensions: Extension[] = [];
  if (readOnly) {
    extensions.push(EditorState.readOnly.of(true));
  }
  let state = createEditorState(initialDoc, extensions);
  const dispatchedEffects: any[] = [];

  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: {
      changes?: unknown;
      selection?: unknown;
      effects?: unknown;
      annotations?: unknown;
      userEvent?: string;
      state?: EditorState;
    }) => {
      if (tr.effects) {
        if (Array.isArray(tr.effects)) {
          dispatchedEffects.push(...tr.effects);
        } else {
          dispatchedEffects.push(tr.effects);
        }
      }
      state = tr.state ?? state.update(tr as Parameters<EditorState["update"]>[0]).state;
    },
    focus: () => {},
    get hasFocus() {
      return true;
    },
    setState: (newState: EditorState) => {
      state = newState;
    },
  };

  const handle = createEditorHandle();
  handle.attach(view as unknown as EditorView, "test-document");

  return {
    handle,
    getState: () => state,
    dispatchEdit: (from: number, to: number, insert: string) => {
      state = state.update({
        changes: { from, to, insert },
        userEvent: "input.type",
      }).state;
    },
    dispatchSelection: (anchor: number, head = anchor) => {
      state = state.update({
        selection: EditorSelection.single(anchor, head),
      }).state;
    },
    dispatchedEffects,
    view,
  };
}

describe("EditorHandle search & bridge contracts", () => {
  it("matches regex and navigates forward and backward with case sensitivity", () => {
    const { handle, getState } = createTestBridge("item1 item22 ITEM3");

    // Case-insensitive regex
    handle.setSearch("item\\d+", false, true);
    const countCI = handle.countMatches("item\\d+", false, true);
    expect(countCI.count).toBe(3);

    // Initial search selects nearest match (first item: "item1")
    const nearest = handle.selectNearestMatch();
    expect(nearest.currentIndex).toBe(1);
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(5); // "item1"

    // findNext moves to second match: "item22"
    handle.findNext();
    expect(getState().selection.main.from).toBe(6);
    expect(getState().selection.main.to).toBe(12); // "item22"

    // findNext moves to third match: "ITEM3"
    handle.findNext();
    expect(getState().selection.main.from).toBe(13);
    expect(getState().selection.main.to).toBe(18); // "ITEM3"

    // Wrap around to start: "item1"
    handle.findNext();
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(5);

    // Case-sensitive regex: ITEM3 no longer matches
    handle.setSearch("item\\d+", true, true);
    const countCS = handle.countMatches("item\\d+", true, true);
    expect(countCS.count).toBe(2);

    handle.findPrevious();
    expect(getState().selection.main.from).toBe(6);
    expect(getState().selection.main.to).toBe(12); // "item22"
  });

  it("preserves exact offsets for literal ignore-case search across length-changing folds", () => {
    // Turkish dotted capital I (\u0130) has a lowercase that changes length in naive toLowerCase().
    const doc = "\u0130x rest";
    const { handle, getState } = createTestBridge(doc);

    handle.setSearch("x", false, false);
    const count = handle.countMatches("x", false, false);
    expect(count.count).toBe(1);

    handle.selectNearestMatch();
    expect(getState().selection.main.from).toBe(1);
    expect(getState().selection.main.to).toBe(2);

    handle.replaceNext("x", "y", false, false);
    expect(getState().doc.toString()).toBe("\u0130y rest");
  });

  it("handles zero-width regex and astral emoji characters without infinite loops", () => {
    const doc = "\u{1F600}\n\u{1F600} world";
    const { handle, getState } = createTestBridge(doc);

    // Zero-width line-start regex
    handle.setSearch("^", false, true);
    const count = handle.countMatches("^", false, true);
    expect(count.count).toBe(2);

    // Cursor is initially at 0. selectNearestMatch selects first zero-width match at 0
    const selectFirst = handle.selectNearestMatch();
    expect(selectFirst.currentIndex).toBe(1);
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(0);

    // findNext advances to the next zero-width match at pos 3 (after emoji\n)
    handle.findNext();
    expect(getState().selection.main.from).toBe(3);
    expect(getState().selection.main.to).toBe(3);

    // Wrap around back to pos 0
    handle.findNext();
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(0);

    // Zero-width lookahead on emoji characters
    handle.setSearch("(?=.)", false, true);
    const lookaheadCount = handle.countMatches("(?=.)", false, true);
    expect(lookaheadCount.count).toBeGreaterThan(0);

    handle.selectNearestMatch();
    expect(getState().selection.main.from).toBe(0);
    handle.findNext();
    // Dot excludes the newline at 2; the next match starts at the next emoji.
    expect(getState().selection.main.from).toBe(3);
  });

  it("replaces with capture groups, unmatched optional groups, escapes, and empty string", () => {
    const doc = "item123 extra item9";
    const { handle, getState } = createTestBridge(doc);

    // $2-$1 reordering
    handle.replaceAll("(item)(\\d+)", "$2-$1", false, true);
    expect(getState().doc.toString()).toBe("123-item extra 9-item");

    // Unmatched optional groups replace with empty string
    // In "foo bar", (foo)?(bar) matches "bar" where (foo)? is unmatched
    const { handle: handle2, getState: getState2 } = createTestBridge("foo bar");
    handle2.replaceAll("(foo)?(bar)", "$1-$2", false, true);
    expect(getState2().doc.toString()).toBe("foo -bar");

    // Replacement escapes \n, \t, \\ in both modes
    const { handle: handle3, getState: getState3 } = createTestBridge("a,b");
    handle3.replaceAll(",", "\\n\\t", false, false);
    expect(getState3().doc.toString()).toBe("a\n\tb");

    // Literal mode keeps $1 as plain text
    const { handle: handle4, getState: getState4 } = createTestBridge("hello world");
    handle4.replaceAll("hello", "$1", false, false);
    expect(getState4().doc.toString()).toBe("$1 world");
  });

  it("advances zero-width replacement line by line in replaceNext", () => {
    const doc = "foo\nbar";
    const { handle, getState } = createTestBridge(doc);

    handle.setSearch("^", false, true, "> ");
    handle.selectNearestMatch();
    expect(getState().selection.main.from).toBe(0);

    // First replace inserts at line 1 and advances to line 2
    handle.replaceNext("^", "> ", false, true);
    expect(getState().doc.toString()).toBe("> foo\nbar");
    expect(getState().selection.main.from).toBe(6); // start of "bar"

    // Second replace inserts at line 2 and wraps around
    handle.replaceNext("^", "> ", false, true);
    expect(getState().doc.toString()).toBe("> foo\n> bar");
    expect(getState().selection.main.from).toBe(0); // wrapped to line 1
  });

  it("isolates replaceAll undo from prior and subsequent typing transactions", () => {
    const { handle, getState, dispatchEdit, view } = createTestBridge("base text");
    expect(undoDepth(getState())).toBe(0);

    // 1. Type before replaceAll
    dispatchEdit(9, 9, " [typed-before]");
    expect(getState().doc.toString()).toBe("base text [typed-before]");
    const depthBefore = undoDepth(getState());
    expect(depthBefore).toBe(1);

    // 2. Run replaceAll
    handle.replaceAll("text", "WORD", false, false);
    expect(getState().doc.toString()).toBe("base WORD [typed-before]");
    const depthReplace = undoDepth(getState());
    expect(depthReplace).toBe(2);

    // 3. Type after replaceAll
    dispatchEdit(0, 0, "[typed-after] ");
    expect(getState().doc.toString()).toBe("[typed-after] base WORD [typed-before]");
    const depthAfter = undoDepth(getState());
    expect(depthAfter).toBe(3);

    // Sequential undo:
    // Step 1: Undoes typing after replaceAll
    undo(view as unknown as Parameters<typeof undo>[0]);
    expect(getState().doc.toString()).toBe("base WORD [typed-before]");

    // Step 2: Undoes ONLY replaceAll, restoring "text"
    undo(view as unknown as Parameters<typeof undo>[0]);
    expect(getState().doc.toString()).toBe("base text [typed-before]");

    // Step 3: Undoes typing before replaceAll
    undo(view as unknown as Parameters<typeof undo>[0]);
    expect(getState().doc.toString()).toBe("base text");
    expect(undoDepth(getState())).toBe(0);
  });

  it("caps count at 1000 while maintaining true currentIndex over 1000 and allowing navigation", () => {
    const countTotal = 1500;
    const doc = "x ".repeat(countTotal);
    const { handle, getState, dispatchSelection } = createTestBridge(doc);

    handle.setSearch("x", true, false);
    const initialCount = handle.countMatches("x", true, false);
    expect(initialCount.count).toBe(1000);
    expect(initialCount.isCapped).toBe(true);

    // Start at beginning
    handle.selectNearestMatch();
    expect(getState().selection.main.from).toBe(0);

    // Jump selection towards match 1202 (index 1201, 0-based pos: 1201 * 2)
    const pos1201 = 1201 * 2;
    dispatchSelection(pos1201, pos1201 + 1);

    // True index is reported as 1202 even though total count is capped at 1000
    const countAfterJump = handle.countMatches("x", true, false);
    expect(countAfterJump.count).toBe(1000);
    expect(countAfterJump.isCapped).toBe(true);
    expect(countAfterJump.currentIndex).toBe(1202);

    // Navigation past the 1000 cap works seamlessly
    handle.findNext();
    expect(getState().selection.main.from).toBe(pos1201 + 2);
  });

  it("respects read-only state and refuses replacement mutations", () => {
    const { handle, getState } = createTestBridge("protected document", true);
    expect(getState().readOnly).toBe(true);

    handle.setSearch("protected", false, false);
    handle.replaceNext("protected", "modified", false, false);
    expect(getState().doc.toString()).toBe("protected document");

    handle.replaceAll("protected", "modified", false, false);
    expect(getState().doc.toString()).toBe("protected document");
  });
  it("simplifies selection hierarchically on Escape", () => {
    const { handle, getState, view } = createTestBridge("first second third");

    // 1. Set multiple selections, with main selection having text (6..12: "second")
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 5), // "first"
        EditorSelection.range(6, 12), // "second" (main)
        EditorSelection.range(13, 18), // "third"
      ], 1),
    });
    expect(getState().selection.ranges.length).toBe(3);

    // Step 1: Escape collapses multiple selections to the main selection range (preserving text!)
    const step1 = handle.simplifySelection();
    expect(step1).toBe(true);
    expect(getState().selection.ranges.length).toBe(1);
    expect(getState().selection.main.from).toBe(6);
    expect(getState().selection.main.to).toBe(12);
    expect(getState().selection.main.empty).toBe(false);

    // Step 2: Next Escape collapses the non-empty main selection to a cursor
    const step2 = handle.simplifySelection();
    expect(step2).toBe(true);
    expect(getState().selection.ranges.length).toBe(1);
    expect(getState().selection.main.empty).toBe(true);
    expect(getState().selection.main.head).toBe(12);

    // Step 3: Next Escape on already empty cursor returns false (not consumed)
    const step3 = handle.simplifySelection();
    expect(step3).toBe(false);
  });

  it("expands and shrinks smart selection through EditorHandle (Spec 013 §2)", () => {
    const { handle, getState, dispatchSelection } = createTestBridge("hello world");
    // Place cursor inside "hello"
    dispatchSelection(2, 2);
    expect(getState().selection.main.from).toBe(2);
    expect(getState().selection.main.to).toBe(2);

    handle.expandSelection();
    // Expands to word "hello" (0..5)
    expect(getState().selection.main.from).toBe(0);
    expect(getState().selection.main.to).toBe(5);

    handle.shrinkSelection();
    // Shrinks back to original cursor at 2
    expect(getState().selection.main.from).toBe(2);
    expect(getState().selection.main.to).toBe(2);
  });

  it("clears smart selection expansion history on setState and reloadDocumentState (Spec 013 §2)", () => {
    const { handle, getState, dispatchSelection } = createTestBridge("hello world");
    dispatchSelection(2, 2);
    handle.expandSelection();
    expect(getState().field(smartSelectionHistoryField).length).toBeGreaterThan(0);

    // State A has expansion history
    const stateA = getState();

    // Switch to document B
    const stateB = createEditorState("second document");
    handle.setState("doc-b", stateB);
    expect(getState().field(smartSelectionHistoryField)).toEqual([]);

    // Switch back to document A: setState applies clearSmartSelectionHistory
    handle.setState("doc-a", stateA);
    expect(getState().field(smartSelectionHistoryField)).toEqual([]);

    // Expand in document A again
    dispatchSelection(1, 1);
    handle.expandSelection();
    expect(getState().field(smartSelectionHistoryField).length).toBeGreaterThan(0);

    // Reloading document A also invalidates expansion history
    const reloaded = getState();
    handle.reloadDocumentState("doc-a", reloaded);
    expect(getState().field(smartSelectionHistoryField)).toEqual([]);
  });

  describe("EditorHandle language reconfiguration (014)", () => {
    it("reconfigures language via dispatch effect without altering doc, selection, undo or smart selection history", () => {
      const { handle, getState, dispatchEdit, dispatchSelection } =
        createTestBridge("const a = 1;");

      // Make an edit so undoDepth > 0
      dispatchEdit(12, 12, "\nconst b = 2;");
      expect(undoDepth(getState())).toBe(1);

      // Expand smart selection so history field is non-empty
      dispatchSelection(6, 6);
      handle.expandSelection();
      expect(
        getState().field(smartSelectionHistoryField).length,
      ).toBeGreaterThan(0);

      const selectionBefore = getState().selection;
      const docBefore = getState().doc.toString();
      const historyBefore = getState().field(smartSelectionHistoryField);

      // Reconfigure language to Python
      handle.reconfigureLanguage("script.py");

      const stateAfter = getState();
      expect(stateAfter.facet(editorLanguageFacet).filename).toBe("script.py");
      expect(stateAfter.facet(editorLanguageFacet).name).toBe("Python");
      // Text, selection, undo history, and smart selection history remain unchanged
      expect(stateAfter.doc.toString()).toBe(docBefore);
      expect(stateAfter.selection.main.from).toBe(selectionBefore.main.from);
      expect(stateAfter.selection.main.to).toBe(selectionBefore.main.to);
      expect(undoDepth(stateAfter)).toBe(1);
      expect(stateAfter.field(smartSelectionHistoryField)).toEqual(
        historyBefore,
      );
    });

    it("resets language to plain text when reconfigured with null", () => {
      const { handle, getState } = createTestBridge("print('hello')");
      handle.reconfigureLanguage("script.py");
      expect(getState().facet(editorLanguageFacet).name).toBe("Python");

      handle.reconfigureLanguage(null);
      expect(getState().facet(editorLanguageFacet).filename).toBeNull();
      expect(getState().facet(editorLanguageFacet).name).toBeNull();
      expect(getState().doc.toString()).toBe("print('hello')");
    });
  });

  describe("Search navigation scrollIntoView effect range and centering (2026-10-27)", () => {
    it("dispatches full range with x: center and y: center on selectNearestMatch", () => {
      const { handle, dispatchedEffects } = createTestBridge("hello world hello");
      handle.setSearch("world", true, false);
      handle.selectNearestMatch();
      const scrollEffect = dispatchedEffects.find(
        (e: any) => e.value && e.value.range && e.value.x === "center" && e.value.y === "center",
      );
      expect(scrollEffect).toBeDefined();
      expect(scrollEffect.value.range.from).toBe(6);
      expect(scrollEffect.value.range.to).toBe(11);
      expect(scrollEffect.value.x).toBe("center");
      expect(scrollEffect.value.y).toBe("center");
    });

    it("dispatches full range with x: center and y: center on findNext", () => {
      const { handle, dispatchedEffects } = createTestBridge("apple banana apple");
      handle.setSearch("banana", true, false);
      handle.findNext();
      const scrollEffect = dispatchedEffects.find(
        (e: any) => e.value && e.value.range && e.value.x === "center" && e.value.y === "center",
      );
      expect(scrollEffect).toBeDefined();
      expect(scrollEffect.value.range.from).toBe(6);
      expect(scrollEffect.value.range.to).toBe(12);
      expect(scrollEffect.value.x).toBe("center");
      expect(scrollEffect.value.y).toBe("center");
    });

    it("dispatches full range with x: center and y: center on findPrevious", () => {
      const { handle, dispatchedEffects, dispatchSelection } = createTestBridge("apple banana apple");
      handle.setSearch("apple", true, false);
      // Place selection at the start of the second match (13..18)
      dispatchSelection(13, 13);
      handle.findPrevious();
      const scrollEffect = dispatchedEffects.find(
        (e: any) => e.value && e.value.range && e.value.x === "center" && e.value.y === "center",
      );
      expect(scrollEffect).toBeDefined();
      expect(scrollEffect.value.range.from).toBe(0);
      expect(scrollEffect.value.range.to).toBe(5);
      expect(scrollEffect.value.x).toBe("center");
      expect(scrollEffect.value.y).toBe("center");
    });

    it("dispatches full range with x: center and y: center on replaceNext", () => {
      const { handle, dispatchedEffects, dispatchSelection } = createTestBridge("cat and cat and cat");
      handle.setSearch("cat", true, false, "dog");
      // Select the first match first
      dispatchSelection(0, 3);
      handle.replaceNext("cat", "dog", true, false);
      const scrollEffect = dispatchedEffects.find(
        (e: any) => e.value && e.value.range && e.value.x === "center" && e.value.y === "center",
      );
      expect(scrollEffect).toBeDefined();
      // First match "cat" at 0..3 is replaced with "dog", advancing to second "cat" at 8..11
      expect(scrollEffect.value.range.from).toBe(8);
      expect(scrollEffect.value.range.to).toBe(11);
      expect(scrollEffect.value.x).toBe("center");
      expect(scrollEffect.value.y).toBe("center");
    });
  });
});
