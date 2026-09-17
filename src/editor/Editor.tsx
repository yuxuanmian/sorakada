import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

import type { DocumentId } from "../app/document/documentSession";
import type { AttachedEditorHandle } from "./editorHandle";

import "../styles/editor.css";

export interface EditorProps {
  /** The handle the application uses to talk to the live document. */
  handle: AttachedEditorHandle;
  /** The document the manager wants shown when the view is created. */
  documentId: DocumentId;
  /** That document's state; the manager owns every later state. */
  initialState: EditorState;
}

/**
 * Hosts the single CodeMirror 6 editor.
 *
 * This component only manages the editor's lifetime: it creates exactly one
 * `EditorView` inside its own DOM container on mount, binds it to the supplied
 * document identity, and destroys it on unmount. Document text, selection,
 * cursor and history are owned by CodeMirror and are deliberately never
 * mirrored into React state.
 *
 * The initial state and identity come from the manager, which keeps owning them
 * afterwards: switching Tabs swaps states through the handle instead of
 * recreating this view.
 */
export function Editor({ handle, documentId, initialState }: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const view = new EditorView({ state: initialState, parent: host });
    handle.attach(view, documentId);
    // A text editor must be ready to type in the moment it appears; nothing
    // else focuses the view on a fresh launch.
    handle.focus();

    // Also runs on React Strict Mode's development double-mount, which keeps
    // the editor free of duplicated views and leaked listeners.
    return () => {
      handle.detach(view);
      view.destroy();
    };
  }, [handle, documentId, initialState]);

  return <div className="editor-host" ref={hostRef} />;
}
