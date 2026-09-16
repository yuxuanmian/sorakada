import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";

import { createEditorState } from "./editorConfig";
import type { AttachedEditorHandle } from "./editorHandle";

import "../styles/editor.css";

export interface EditorProps {
  /** The handle the application uses to talk to the live document. */
  handle: AttachedEditorHandle;
}

/**
 * Hosts the single CodeMirror 6 editor.
 *
 * This component only manages the editor's lifetime: it creates the
 * `EditorView` inside its own DOM container on mount, binds it to the supplied
 * `EditorHandle`, and destroys it on unmount. Document text, selection, cursor
 * and history are owned by CodeMirror and are deliberately never mirrored into
 * React state — the handle is the only channel the application uses to read or
 * replace the document.
 */
export function Editor({ handle }: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const view = new EditorView({
      state: createEditorState("", handle.extensions),
      parent: host,
    });
    handle.attach(view);

    // Also runs on React Strict Mode's development double-mount, which keeps
    // the editor free of duplicated views and leaked resources.
    return () => {
      handle.detach(view);
      view.destroy();
    };
  }, [handle]);

  return <div className="editor-host" ref={hostRef} />;
}
