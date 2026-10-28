import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { history, redoDepth, undoDepth } from "@codemirror/commands";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { emptyLineMouseSelectionStyle } from "./emptyLineSelection";
import { multiCursorMouse } from "./multiCursorMouse";

function mouse(pos: number, overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0, detail: 1, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    clientX: pos, clientY: 0, ...overrides,
  } as MouseEvent;
}

function setup(doc = "ab\n\ncd", selection = EditorSelection.single(0)) {
  let state = EditorState.create({
    doc, selection,
    extensions: [emptyLineMouseSelectionStyle(), EditorState.allowMultipleSelections.of(true), history()],
  });
  const view = {
    get state() { return state; },
    // x identifies a document position; assoc remains the public CM hit-test result.
    posAndSideAtCoords: vi.fn(({ x }: { x: number; y: number }) => ({ pos: x, assoc: -1 as const })),
  };
  const factory = state.facet(EditorView.mouseSelectionStyle)[0];
  const start = (pos: number, overrides: Partial<MouseEvent> = {}) => factory(view as never, mouse(pos, overrides));
  const apply = (spec: TransactionSpec, style?: ReturnType<typeof start>) => {
    const tr = state.update(spec);
    state = tr.state;
    style?.update({ startState: tr.startState, state, changes: tr.changes, docChanged: tr.docChanged } as ViewUpdate);
  };
  return { view, start, apply, replace: (next: EditorState) => { state = next; } };
}

describe("ordinary selection starting on an empty logical line", () => {
  it("copies the real starting newline on upward drag and preserves hit-test assoc", () => {
    const { view, start } = setup();
    const style = start(3)!;
    const selection = style.get(mouse(1), false, false);
    expect(selection.main.anchor).toBe(4);
    expect(selection.main.head).toBe(1);
    expect(selection.main.assoc).toBe(-1);
    expect(view.state.sliceDoc(selection.main.from, selection.main.to)).toBe("b\n\n");
  });

  it("does not preselect on click, and recomputes upward, foldback, and downward boundaries", () => {
    const { start } = setup();
    const style = start(3)!;
    const at = (pos: number) => {
      const main = style.get(mouse(pos), false, false).main;
      return [main.anchor, main.head];
    };
    expect(at(3)).toEqual([3, 3]);
    expect(at(1)).toEqual([4, 1]);
    expect(at(3)).toEqual([3, 3]);
    expect(at(5)).toEqual([3, 5]);
    expect(at(1)).toEqual([4, 1]);
  });

  it("keeps the final empty line at doc.length without inventing a newline", () => {
    const { view, start } = setup("ab\n");
    const style = start(3)!;
    expect(style.get(mouse(3), false, false).main.empty).toBe(true);
    const selection = style.get(mouse(1), false, false);
    expect([selection.main.anchor, selection.main.head]).toEqual([3, 1]);
    expect(view.state.sliceDoc(selection.main.from, selection.main.to)).toBe("b\n");
    expect(selection.main.to).toBe(view.state.doc.length);
  });

  it("leaves document identity and text undo history unchanged through real selection transactions", () => {
    const fixture = setup();
    fixture.apply({ changes: { from: 6, insert: "!" }, userEvent: "input.type" });
    const before = fixture.view.state;
    expect(undoDepth(before)).toBe(1);
    const style = fixture.start(3)!;
    for (const pos of [3, 1, 3, 5]) {
      fixture.apply({ selection: style.get(mouse(pos), false, false), userEvent: "select.pointer" }, style);
      expect(fixture.view.state.doc).toBe(before.doc);
      expect(fixture.view.state.doc.toString()).toBe("ab\n\ncd!");
      expect(undoDepth(fixture.view.state)).toBe(undoDepth(before));
      expect(redoDepth(fixture.view.state)).toBe(redoDepth(before));
    }
  });

  it.each([
    { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true },
    { ctrlKey: true, shiftKey: true, altKey: true }, { detail: 2 }, { detail: 3 }, { button: 1 },
  ])("passes through other gestures: %j", (overrides) => {
    expect(setup().start(3, overrides)).toBeNull();
  });

  it("passes through nonempty and whitespace lines, existing selected text, and multiple ranges", () => {
    expect(setup().start(1)).toBeNull();
    expect(setup("ab\n \ncd").start(3)).toBeNull();
    expect(setup("ab\n\ncd", EditorSelection.single(1, 5)).start(3)).toBeNull();
    expect(setup("ab\n\ncd", EditorSelection.create([
      EditorSelection.cursor(0), EditorSelection.cursor(5),
    ])).start(3)).toBeNull();
  });

  it("collapses a selection elsewhere on single click, leaving CM to control drag timing", () => {
    const { start } = setup("ab\n\ncd", EditorSelection.single(0, 2));
    const result = start(3)!.get(mouse(3), false, false);
    expect(result.ranges).toHaveLength(1);
    expect(result.main.empty).toBe(true);
    expect(result.main.head).toBe(3);
  });

  it("maps the anchor on document changes without hit-testing during update", () => {
    const fixture = setup();
    const style = fixture.start(3)!;
    fixture.view.posAndSideAtCoords.mockClear();
    fixture.apply({ changes: { from: 0, insert: "xy\n" } }, style);
    expect(fixture.view.posAndSideAtCoords).not.toHaveBeenCalled();
    const selection = style.get(mouse(4), false, false);
    expect([selection.main.anchor, selection.main.head]).toEqual([7, 4]);
    expect(fixture.view.state.sliceDoc(selection.main.from, selection.main.to)).toBe("b\n\n");
  });

  it.each([false, true])("invalidates an old style after setState (shared doc: %s)", (sharedDoc) => {
    const fixture = setup();
    const style = fixture.start(3)!;
    const replacement = EditorState.create({
      doc: sharedDoc ? fixture.view.state.doc : "new document",
      selection: EditorSelection.single(2),
    });
    fixture.replace(replacement);
    fixture.view.posAndSideAtCoords.mockClear();
    expect(style.get(mouse(0), false, false)).toBe(replacement.selection);
    fixture.apply({ changes: { from: 0, insert: "!" } }, style);
    expect(style.get(mouse(0), false, false)).toBe(fixture.view.state.selection);
    expect(fixture.view.posAndSideAtCoords).not.toHaveBeenCalled();
  });

  it("is installed in the existing mouse bundle and only intercepts empty-line plain clicks", () => {
    const state = EditorState.create({ doc: "ab\n\ncd", extensions: multiCursorMouse() });
    const view = { state, posAndSideAtCoords: ({ x }: { x: number }) => ({ pos: x, assoc: 1 }) };
    const factories = state.facet(EditorView.mouseSelectionStyle);
    const ordinary = factories.map((factory) => factory(view as never, mouse(3))).filter(Boolean);
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]!.get(mouse(1), false, false).main.anchor).toBe(4);
    expect(factories.every((factory) => factory(view as never, mouse(1)) === null)).toBe(true);
  });
});
