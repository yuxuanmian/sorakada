import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { undo, undoDepth } from "@codemirror/commands";
import {
  clearClipCache,
  CLIP_MIME,
  computePasteReplacements,
  extractCopyRanges,
  getClip,
  handleCopyOrCut,
  handlePaste,
  storeClip,
} from "./multiCursorClipboard";
import { createEditorState } from "./editorConfig";

function createMockClipboardEvent(type: "copy" | "cut" | "paste"): {
  event: ClipboardEvent;
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  const clipboardData = {
    setData(format: string, val: string) {
      data.set(format, val);
    },
    getData(format: string) {
      return data.get(format) ?? "";
    },
    clearData() {
      data.clear();
    },
  };
  const event = {
    type,
    clipboardData,
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
  return { event, data };
}

describe("multiCursorClipboard extraction & rules", () => {
  it("extracts non-empty selections in document order and marks linewise false", () => {
    const state = EditorState.create({
      doc: "first line\nsecond line\nthird line",
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([
        EditorSelection.range(0, 5), // "first"
        EditorSelection.range(11, 17), // "second"
      ]),
    });

    const { segments, fullText, linewise, cutRanges } = extractCopyRanges(state);
    expect(linewise).toBe(false);
    expect(segments).toEqual(["first", "second"]);
    expect(fullText).toBe("first\nsecond");
    expect(cutRanges).toEqual([
      { from: 0, to: 5 },
      { from: 11, to: 17 },
    ]);
  });

  it("copies only non-empty ranges when empty and non-empty selections are mixed", () => {
    const state = EditorState.create({
      doc: "alpha beta gamma",
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([
        EditorSelection.cursor(2), // empty
        EditorSelection.range(6, 10), // "beta"
        EditorSelection.cursor(12), // empty
      ]),
    });

    const { segments, fullText, linewise, cutRanges } = extractCopyRanges(state);
    expect(linewise).toBe(false);
    expect(segments).toEqual(["beta"]);
    expect(fullText).toBe("beta");
    expect(cutRanges).toEqual([{ from: 6, to: 10 }]);
  });

  it("performs whole-line copy when all selections are empty, deduplicating same-line cursors", () => {
    const state = EditorState.create({
      doc: "line one\nline two\nline three",
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([
        EditorSelection.cursor(2), // line 1
        EditorSelection.cursor(5), // line 1 (same line)
        EditorSelection.cursor(12), // line 2
      ]),
    });

    const { segments, fullText, linewise, cutRanges } = extractCopyRanges(state);
    expect(linewise).toBe(true);
    // Line 1 is only copied once, followed by line 2
    expect(segments).toEqual(["line one", "line two"]);
    expect(fullText).toBe("line one\nline two");
    // cutRanges cover line 1 with newline and line 2 with newline
    expect(cutRanges).toEqual([
      { from: 0, to: 9 }, // "line one\n"
      { from: 9, to: 18 }, // "line two\n"
    ]);
  });

  it("preserves literal backslash-n without escape decoding", () => {
    const state = EditorState.create({
      doc: "literal\\ntext\tmore",
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.range(0, 13)]),
    });

    const { segments } = extractCopyRanges(state);
    expect(segments[0]).toBe("literal\\ntext");
  });
});

describe("computePasteReplacements decision table (Spec §3, A04, A05)", () => {
  it("maps 1-to-1 when segment count equals multiple target count", () => {
    const segments = ["segA", "segB\nmultiline", "segC"];
    const res = computePasteReplacements(segments, "unused", 3);
    expect(res).toEqual(["segA", "segB\nmultiline", "segC"]);
  });

  it("inserts the full single multiline segment into all multiple targets", () => {
    const segments = ["line1\nline2\nline3"];
    // Even though line count is 3 and targetCount is 3, it inserts the FULL segment into all 3 targets
    const res = computePasteReplacements(segments, "unused", 3);
    expect(res).toEqual([
      "line1\nline2\nline3",
      "line1\nline2\nline3",
      "line1\nline2\nline3",
    ]);
  });

  it("joins multiple segments with newline when pasted into a single target", () => {
    const segments = ["part1", "part2", "part3"];
    const res = computePasteReplacements(segments, "unused", 1, "\n");
    expect(res).toEqual(["part1\npart2\npart3"]);
  });

  it("inserts full joined text into each target when segment count does not match multiple targets", () => {
    const segments = ["A", "B"];
    // 2 segments pasted into 3 targets
    const res = computePasteReplacements(segments, "unused", 3, "\n");
    expect(res).toEqual(["A\nB", "A\nB", "A\nB"]);
  });

  it("distributes line-by-line for external plain text when line count equals target count", () => {
    const plainText = "row1\nrow2\nrow3";
    const res = computePasteReplacements(null, plainText, 3);
    expect(res).toEqual(["row1", "row2", "row3"]);
  });

  it("inserts full plain text into each target when line count does not equal target count", () => {
    const plainText = "row1\nrow2";
    const res = computePasteReplacements(null, plainText, 3);
    expect(res).toEqual(["row1\nrow2", "row1\nrow2", "row1\nrow2"]);
  });
});

describe("multiCursorClipboard interactive event handlers & cache", () => {
  it("stores and retrieves clips by ID, evicting oldest when reaching limit", () => {
    clearClipCache();
    storeClip({
      id: "clip-1",
      text: "hello",
      segments: ["hello"],
      linewise: false,
    });
    expect(getClip("clip-1")).toEqual({
      id: "clip-1",
      text: "hello",
      segments: ["hello"],
      linewise: false,
    });
    expect(getClip("clip-unknown")).toBeNull();
  });

  it("executes copy and cut, populating text/plain and private metadata ID", () => {
    clearClipCache();
    let state = createEditorState("first second third", []);
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(6, 12),
      ]),
    }).state;

    const view = {
      state,
      dispatch: (tr: { changes?: unknown; userEvent?: string }) => {
        state = state.update(tr as Parameters<EditorState["update"]>[0]).state;
      },
    };

    const { event, data } = createMockClipboardEvent("copy");
    const handled = handleCopyOrCut(event, view as never, false);

    expect(handled).toBe(true);
    expect(data.get("text/plain")).toBe("first\nsecond");
    const rawMeta = data.get(CLIP_MIME);
    expect(rawMeta).toBeDefined();
    const parsed = JSON.parse(rawMeta!);
    expect(typeof parsed.id).toBe("string");
    const cached = getClip(parsed.id);
    expect(cached?.segments).toEqual(["first", "second"]);
    expect(cached?.linewise).toBe(false);

    // Cut deletes the ranges atomically
    const { event: cutEvent } = createMockClipboardEvent("cut");
    handleCopyOrCut(cutEvent, view as never, true);
    expect(state.doc.toString()).toBe("  third");
  });

  it("refuses cut and leaves document untouched when clipboardData is null", () => {
    const originalText = "alpha beta gamma";
    let state = createEditorState(originalText, []);
    state = state.update({
      selection: EditorSelection.range(0, 5),
    }).state;

    let dispatched = false;
    const view = {
      state,
      dispatch: () => {
        dispatched = true;
      },
    };

    const event = {
      type: "cut",
      clipboardData: null,
      preventDefault: () => {},
    } as unknown as ClipboardEvent;

    const handled = handleCopyOrCut(event, view as never, true);
    expect(handled).toBe(false);
    expect(dispatched).toBe(false);
    expect(state.doc.toString()).toBe(originalText);
  });

  it("refuses cut and leaves document untouched when clipboardData.setData throws", () => {
    const originalText = "hello world";
    let state = createEditorState(originalText, []);
    state = state.update({
      selection: EditorSelection.range(0, 5),
    }).state;

    let dispatched = false;
    const view = {
      state,
      dispatch: () => {
        dispatched = true;
      },
    };

    const event = {
      type: "cut",
      clipboardData: {
        clearData() {},
        setData() {
          throw new Error("clipboard write restricted");
        },
        getData() {
          return "";
        },
      },
      preventDefault: () => {},
    } as unknown as ClipboardEvent;

    const handled = handleCopyOrCut(event, view as never, true);
    expect(handled).toBe(false);
    expect(dispatched).toBe(false);
    expect(state.doc.toString()).toBe(originalText);
  });

  it("copies and pastes an empty line linewise, roundtripping correctly", () => {
    clearClipCache();
    // 3 lines: line 2 is completely empty
    let state = createEditorState("line 1\n\nline 3", []);
    // Cursor on empty line 2 (offset 7)
    state = state.update({
      selection: EditorSelection.cursor(7),
    }).state;

    const view = {
      get state() {
        return state;
      },
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
      },
    };

    // 1. Copy the empty line
    const { event: copyEvent, data } = createMockClipboardEvent("copy");
    const copyHandled = handleCopyOrCut(copyEvent, view as never, false);
    expect(copyHandled).toBe(true);
    expect(data.get("text/plain")).toBe("");
    const parsed = JSON.parse(data.get(CLIP_MIME)!);
    const cached = getClip(parsed.id);
    expect(cached?.linewise).toBe(true);
    expect(cached?.text).toBe("");
    expect(cached?.segments).toEqual([""]);

    // 2. Move cursor to line 1 and paste
    state = state.update({
      selection: EditorSelection.cursor(0),
    }).state;

    const { event: pasteEvent } = createMockClipboardEvent("paste");
    (pasteEvent.clipboardData as unknown as { setData: (k: string, v: string) => void })
      .setData("text/plain", "");
    (pasteEvent.clipboardData as unknown as { setData: (k: string, v: string) => void })
      .setData(CLIP_MIME, JSON.stringify({ id: parsed.id }));

    const pasteHandled = handlePaste(pasteEvent, view as never);
    expect(pasteHandled).toBe(true);
    // Linewise paste inserted an empty line above line 1
    expect(state.doc.toString()).toBe("\nline 1\n\nline 3");
  });

  it("pastes segmented data across targets and verifies atomic undo", () => {
    clearClipCache();
    let state = createEditorState("1 2 3", []);
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 1), // "1"
        EditorSelection.range(2, 3), // "2"
        EditorSelection.range(4, 5), // "3"
      ]),
    }).state;

    const view = {
      state,
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
      },
    };

    const { event, data } = createMockClipboardEvent("paste");
    data.set("text/plain", "alpha\nbeta\ngamma");
    const payload = {
      id: "test-id",
      text: "alpha\nbeta\ngamma",
      segments: ["alpha", "beta", "gamma"],
      linewise: false,
    };
    storeClip(payload);
    data.set(CLIP_MIME, JSON.stringify({ id: payload.id }));

    const handled = handlePaste(event, view as never);
    expect(handled).toBe(true);
    expect(state.doc.toString()).toBe("alpha beta gamma");
    expect(undoDepth(state)).toBe(1);

    // Single atomic undo restores original text and selections
    undo({ state, dispatch: (tr) => { state = state.update(tr).state; } });
    expect(state.doc.toString()).toBe("1 2 3");
  });

  it("ignores stale metadata if plain text was altered externally", () => {
    clearClipCache();
    let state = createEditorState("x y", []);
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 1),
        EditorSelection.range(2, 3),
      ]),
    }).state;

    const view = {
      state,
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
      },
    };

    const { event, data } = createMockClipboardEvent("paste");
    // External application altered text/plain without removing old private MIME
    data.set("text/plain", "completely new text");
    const stalePayload = {
      id: "stale-id",
      text: "old text",
      segments: ["old", "text"],
      linewise: false,
    };
    storeClip(stalePayload);
    data.set(CLIP_MIME, JSON.stringify({ id: stalePayload.id }));

    handlePaste(event, view as never);
    // Because text didn't match stalePayload.text, it treats it as plain text.
    // 1 line of plain text pasted to 2 targets -> each gets "completely new text"
    expect(state.doc.toString()).toBe("completely new text completely new text");
  });

  it("safely falls back to plain text when metadata id is a cache miss", () => {
    clearClipCache();
    let state = createEditorState("x y", []);
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 1),
        EditorSelection.range(2, 3),
      ]),
    }).state;

    const view = {
      state,
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
      },
    };

    const { event, data } = createMockClipboardEvent("paste");
    data.set("text/plain", "row1\nrow2");
    data.set(CLIP_MIME, JSON.stringify({ id: "missing-clip-id" }));

    handlePaste(event, view as never);
    // Cache miss falls back to plain text. 2 lines pasted into 2 targets -> line-by-line distribution
    expect(state.doc.toString()).toBe("row1 row2");
  });

  it("safely ignores external raw segments payload without valid cache entry", () => {
    clearClipCache();
    let state = createEditorState("x y", []);
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 1),
        EditorSelection.range(2, 3),
      ]),
    }).state;

    const view = {
      state,
      dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
        state = state.update(tr).state;
      },
    };

    const { event, data } = createMockClipboardEvent("paste");
    // External app attempts to inject raw segments directly into clipboard payload
    data.set("text/plain", "pure plain text");
    data.set(
      CLIP_MIME,
      JSON.stringify({
        id: "forged",
        text: "pure plain text",
        segments: ["injected1", "injected2"],
      }),
    );

    handlePaste(event, view as never);
    // Because "forged" was not stored in module cache, it is NOT trusted
    // 1 line of plain text pasted into 2 targets -> each gets "pure plain text"
    expect(state.doc.toString()).toBe("pure plain text pure plain text");
  });

  it("refuses cut mutations on read-only document", () => {
    const state = EditorState.create({
      doc: "immutable text",
      extensions: [EditorState.readOnly.of(true)],
      selection: EditorSelection.single(0, 9),
    });

    let dispatched = false;
    const view = {
      state,
      dispatch: () => {
        dispatched = true;
      },
    };

    const { event } = createMockClipboardEvent("cut");
    handleCopyOrCut(event, view as never, true);
    expect(dispatched).toBe(false);
  });
});
