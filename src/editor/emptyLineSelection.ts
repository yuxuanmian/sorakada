import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Include the starting empty line's newline when an ordinary drag goes upward. */
export function emptyLineMouseSelectionStyle(): Extension {
  return Prec.highest(EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.detail !== 1 || event.ctrlKey ||
        event.shiftKey || event.altKey || event.metaKey ||
        view.state.selection.ranges.length !== 1) return null;

    const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (!start || view.state.doc.lineAt(start.pos).length !== 0) return null;

    // Let CM's native style handle clicks within selected text, including drag-and-drop.
    const main = view.state.selection.main;
    if (!main.empty && start.pos >= main.from && start.pos <= main.to) return null;

    let anchor = start.pos;
    let startSel = view.state.selection;
    let expectedState = view.state;
    let active = true;

    return {
      update(update) {
        // setState does not end CM's mouse session. Never map an old gesture into a new state.
        if (!active || update.startState !== expectedState) {
          active = false;
          return;
        }
        if (update.docChanged) {
          anchor = update.changes.mapPos(anchor);
          startSel = startSel.map(update.changes);
        }
        expectedState = update.state;
      },
      get(curEvent, extend, multiple) {
        if (!active || view.state !== expectedState) {
          active = false;
          return view.state.selection;
        }
        const cur = view.posAndSideAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false);
        if (!cur) return startSel;

        const line = view.state.doc.lineAt(anchor);
        const includeNewline = cur.pos < anchor && line.from === anchor &&
          line.length === 0 && anchor < view.state.doc.length;
        const range = cur.pos === anchor
          ? EditorSelection.cursor(anchor, cur.assoc)
          : EditorSelection.range(includeNewline ? anchor + 1 : anchor, cur.pos, undefined, undefined, cur.assoc);

        if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
        if (multiple) return startSel.addRange(range);
        return EditorSelection.create([range]);
      },
    };
  }));
}
