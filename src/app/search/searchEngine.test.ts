import { describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { undo, undoDepth } from "@codemirror/commands";
import {
  replaceAll,
  SearchCursor,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";

import {
  createEditorState,
  searchDecorationPlugin,
} from "../../editor/editorConfig";
import { computeReplacement, findAllMatches, getCachedMatches } from "./searchEngine";

describe("shared matching rules", () => {
  it("advances zero-width matches across complete Unicode code points", () => {
    expect(findAllMatches("😀x", "(?=.)", true, true).map(m => m.from)).toEqual([0, 2]);
    expect(findAllMatches("😀\nx", "$", true, true).map(m => m.from)).toEqual([2, 4]);
  });

  it("retains ordinary search escapes and literal regex punctuation", () => {
    expect(findAllMatches("a\nb a\\nb .[", "\\n", true, false).map(m => m.from)).toEqual([1]);
    expect(findAllMatches("a\nb a\\nb .[", ".[", true, false).map(m => [m.from, m.to])).toEqual([[9, 11]]);
  });

  it("expands captures up to 99 without interpreting captured backslashes", () => {
    const groups = ["whole", "\\n", undefined, ...Array(96).fill("x"), "last"];
    expect(computeReplacement("$1|$2|$99|$&|$$|$0", groups as string[], true))
      .toBe("\\n||last|whole|$|$0");
    expect(computeReplacement("$1\\n", ["whole"], false)).toBe("$1\n");
  });

  it("reuses matches without flattening an unchanged immutable document", () => {
    const doc = Text.of(["x x"]);
    const flatten = vi.spyOn(doc, "toString");
    const first = getCachedMatches(doc, "x", true, false);
    expect(getCachedMatches(doc, "x", true, false)).toBe(first);
    expect(flatten).toHaveBeenCalledTimes(1);
    expect(getCachedMatches(doc, "z", true, false)).toEqual([]);
    expect(flatten).toHaveBeenCalledTimes(2);
  });
});

describe("searchEngine transaction & cursor contracts", () => {
  it("counts matches correctly with case sensitivity toggle", () => {
    const doc = "Alpha alpha ALPHA beta alpha";
    const state = createEditorState(doc);

    // Case-insensitive
    const cursorCI = new SearchCursor(
      state.doc,
      "alpha",
      0,
      state.doc.length,
      (x) => x.toLowerCase(),
    );
    let countCI = 0;
    while (!cursorCI.next().done) {
      countCI += 1;
    }
    expect(countCI).toBe(4);

    // Case-sensitive
    const cursorCS = new SearchCursor(state.doc, "alpha", 0, state.doc.length);
    let countCS = 0;
    while (!cursorCS.next().done) {
      countCS += 1;
    }
    expect(countCS).toBe(2);
  });

  it("caps match counting at 1000 for safety", () => {
    const doc = "a ".repeat(1500);
    const state = createEditorState(doc);

    const cursor = new SearchCursor(state.doc, "a", 0, state.doc.length);
    let count = 0;
    let isCapped = false;
    const MAX = 1000;
    while (!cursor.next().done) {
      count += 1;
      if (count >= MAX) {
        isCapped = true;
        break;
      }
    }
    expect(count).toBe(1000);
    expect(isCapped).toBe(true);
  });

  it("replaces all matches in a single atomic transaction and undoes in one step", () => {
    let state = createEditorState("foo 1 foo 2 foo 3");
    expect(undoDepth(state)).toBe(0);

    const query = new SearchQuery({ search: "foo", replace: "bar" });
    state = state.update({ effects: setSearchQuery.of(query) }).state;

    const mockView = {
      get state() {
        return state;
      },
      dispatch: (tr: any) => {
        state = tr.state ?? state.update(tr).state;
      },
    };

    replaceAll(mockView as unknown as Parameters<typeof replaceAll>[0]);

    expect(state.doc.toString()).toBe("bar 1 bar 2 bar 3");
    // Single transaction recorded in history:
    expect(undoDepth(state)).toBe(1);

    // Undo should restore entire original document in 1 single step:
    undo(mockView as unknown as Parameters<typeof undo>[0]);
    expect(state.doc.toString()).toBe("foo 1 foo 2 foo 3");
    expect(undoDepth(state)).toBe(0);
  });

  it("supports replacing with empty string (bulk deletion)", () => {
    let state = createEditorState("hello [delete_me] world [delete_me]");
    const query = new SearchQuery({ search: "[delete_me]", replace: "" });
    state = state.update({ effects: setSearchQuery.of(query) }).state;

    const mockView = {
      state,
      dispatch: (tr: any) => {
        state = state.update(tr).state;
      },
    };

    replaceAll(mockView as unknown as Parameters<typeof replaceAll>[0]);
    expect(state.doc.toString()).toBe("hello  world ");
    expect(undoDepth(state)).toBe(1);
  });

  it("decorates search matches immediately on query dispatch and tracks selection", () => {
    let state = createEditorState("alpha beta alpha gamma");

    const mockView = {
      get state() {
        return state;
      },
      visibleRanges: [{ from: 0, to: state.doc.length }],
    };

    const pluginInstance = (
      searchDecorationPlugin as unknown as {
        create: (view: unknown) => {
          decorations: {
            size: number;
            between: (
              from: number,
              to: number,
              cb: (from: number, to: number, value: { spec: { class?: string } }) => void,
            ) => void;
          };
          update: (u: unknown) => void;
        };
      }
    ).create(mockView);

    expect(pluginInstance.decorations.size).toBe(0);

    // Dispatch query to state
    const query = new SearchQuery({ search: "alpha" });
    const update1 = state.update({ effects: setSearchQuery.of(query) });
    const startState1 = state;
    state = update1.state;

    pluginInstance.update({
      view: mockView,
      state,
      startState: startState1,
      docChanged: false,
      selectionSet: false,
      viewportChanged: false,
    });

    expect(pluginInstance.decorations.size).toBe(2);

    const ranges: { from: number; to: number; className?: string }[] = [];
    pluginInstance.decorations.between(
      0,
      state.doc.length,
      (from: number, to: number, value: { spec: { class?: string } }) => {
        ranges.push({ from, to, className: value.spec.class });
      },
    );

    expect(ranges).toEqual([
      { from: 0, to: 5, className: "cm-searchMatch" },
      { from: 11, to: 16, className: "cm-searchMatch" },
    ]);

    // Move selection to first match
    const update2 = state.update({ selection: { anchor: 0, head: 5 } });
    const startState2 = state;
    state = update2.state;

    pluginInstance.update({
      view: mockView,
      state,
      startState: startState2,
      docChanged: false,
      selectionSet: true,
      viewportChanged: false,
    });

    const updatedRanges: { from: number; to: number; className?: string }[] = [];
    pluginInstance.decorations.between(
      0,
      state.doc.length,
      (from: number, to: number, value: { spec: { class?: string } }) => {
        updatedRanges.push({
          from,
          to,
          className: value.spec.class,
        });
      },
    );

    expect(updatedRanges).toEqual([
      {
        from: 0,
        to: 5,
        className: "cm-searchMatch cm-searchMatch-current cm-searchMatch-selected",
      },
      { from: 11, to: 16, className: "cm-searchMatch" },
    ]);

    // Clear query
    const clearQuery = new SearchQuery({ search: "" });
    const update3 = state.update({ effects: setSearchQuery.of(clearQuery) });
    const startState3 = state;
    state = update3.state;

    pluginInstance.update({
      view: mockView,
      state,
      startState: startState3,
      docChanged: false,
      selectionSet: false,
      viewportChanged: false,
    });

    expect(pluginInstance.decorations.size).toBe(0);
  });
});
describe("multiline search and replace pipeline", () => {
  it("finds multiline literal matches across newlines", () => {
    const doc = "alpha\nbeta\ngamma\nalpha\nbeta";
    const query = "alpha\nbeta";
    const matches = findAllMatches(doc, query, true, false);
    expect(matches.map(m => [m.from, m.to])).toEqual([
      [0, 10],
      [17, 27],
    ]);
  });

  it("finds multiline matches containing punctuation literally", () => {
    const doc = "function run() {\n  return a[0] + 1;\n}";
    const query = "run() {\n  return a[0]";
    const matches = findAllMatches(doc, query, true, false);
    expect(matches.length).toBe(1);
    expect(doc.slice(matches[0].from, matches[0].to)).toBe(query);
  });

  it("finds multiline regex matches matching across line boundaries", () => {
    const doc = "section 1:\n  data A\nsection 2:\n  data B";
    const query = "section \\d+:\\n\\s+data [A-Z]";
    const matches = findAllMatches(doc, query, true, true);
    expect(matches.length).toBe(2);
    expect(doc.slice(matches[0].from, matches[0].to)).toBe("section 1:\n  data A");
    expect(doc.slice(matches[1].from, matches[1].to)).toBe("section 2:\n  data B");
  });

  it("handles multiline replacement templates with and without capture groups", () => {
    const literalReplaced = computeReplacement("lineA\nlineB", ["match"], false);
    expect(literalReplaced).toBe("lineA\nlineB");

    const regexReplaced = computeReplacement("line1:\n$1\nline2:\n$2", ["match", "val1", "val2"], true);
    expect(regexReplaced).toBe("line1:\nval1\nline2:\nval2");
  });

  it("aligns CodeMirror SearchCursor and SearchQuery with searchEngine multiline results", () => {
    const docText = "start\nitem 1\nitem 2\nend";
    const state = createEditorState(docText);
    const query = "item 1\nitem 2";

    const cmMatches = findAllMatches(docText, query, true, false);
    expect(cmMatches.length).toBe(1);
    expect(cmMatches[0].from).toBe(6);
    expect(cmMatches[0].to).toBe(19);

    const cursor = new SearchCursor(state.doc, query, 0, state.doc.length);
    const next = cursor.next();
    expect(next.done).toBe(false);
    expect(next.value.from).toBe(6);
    expect(next.value.to).toBe(19);
  });
});
