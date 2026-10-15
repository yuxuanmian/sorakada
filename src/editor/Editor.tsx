import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

import type { DocumentId } from "../app/document/documentSession";
import type { AttachedEditorHandle } from "./editorHandle";

import "../styles/editor.css";

export interface EditorProps {
  /** The handle the application uses to talk to the live document. */
  handle: AttachedEditorHandle;
  /** The document the view must be created with. */
  documentId: DocumentId;
  /** That document's state at mount time; the manager owns every later state. */
  initialState: EditorState;
}

/**
 * Hosts the single CodeMirror 6 editor.
 *
 * This component manages the editor's lifetime only: it creates exactly one
 * `EditorView` inside its own DOM container on mount, binds it to the supplied
 * document identity, and destroys it on unmount. Document text, selection,
 * cursor and history are owned by CodeMirror and are deliberately never mirrored
 * into React state.
 *
 * 003 mounts this component exactly while at least one document is open:
 *
 * - zero -> one document mounts the shared view;
 * - Tab switches keep it mounted and swap `EditorState` through the handle;
 * - one -> zero unmounts and destroys it, and the Empty State takes its place.
 *
 * For that to hold, the view must be created from the state that was current at
 * *mount* time and must not be recreated when the `documentId` prop changes
 * during a Tab switch — hence the captured mount values and the `handle`-only
 * effect dependency.
 */
export function Editor({ handle, documentId, initialState }: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<{ documentId: DocumentId; initialState: EditorState } | null>(
    null,
  );
  if (mountRef.current === null) {
    mountRef.current = { documentId, initialState };
  }

  useEffect(() => {
    const host = hostRef.current;
    const mount = mountRef.current;
    if (!host || !mount) {
      return;
    }

    const view = new EditorView({ state: mount.initialState, parent: host });
    handle.attach(view, mount.documentId);
    // A text editor must be ready to type in the moment it appears; nothing
    // else focuses the view after a zero -> one transition.
    handle.focus();

    // Also runs on React Strict Mode's development double-mount, which keeps
    // the editor free of duplicated views and leaked listeners.
    return () => {
      handle.detach(view);
      view.destroy();
    };
  }, [handle]);

  return <div className="editor-host" ref={hostRef} />;
}
