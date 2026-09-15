import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";

import { createEditorState } from "./editorConfig";

import "../styles/editor.css";

/**
 * Hosts a single CodeMirror 6 editor.
 *
 * This component only manages the editor's lifetime: it creates the
 * `EditorView` inside its own DOM container on mount and destroys it on
 * unmount. Document text, selection, cursor and history are owned by
 * CodeMirror and are deliberately never mirrored into React state.
 */
export function Editor() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const view = new EditorView({
      state: createEditorState(),
      parent: host,
    });

    // Also runs on React Strict Mode's development double-mount, which keeps
    // the editor free of duplicated views and leaked resources.
    return () => {
      view.destroy();
    };
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
