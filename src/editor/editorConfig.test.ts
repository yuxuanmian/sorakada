import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { undoDepth } from "@codemirror/commands";

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
