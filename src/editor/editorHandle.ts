import type { Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";

import { createEditorState } from "./editorConfig";

/** Invoked whenever CodeMirror reports that the document text changed. */
export type DocumentChangeListener = () => void;

/**
 * The imperative operations the application layer needs from the editor.
 *
 * Everything here is addressed to the *active* CodeMirror view, so that no
 * caller has to know about `EditorView` or mirror the document into React
 * state. `setDocument` deliberately does not raise a document-change
 * notification: the caller that replaces the document also owns the baseline
 * that replacement establishes.
 */
export interface EditorHandle {
  /** Whether a CodeMirror view is currently attached. */
  isReady(): boolean;
  /** The current immutable logical document. */
  getDocument(): Text;
  /**
   * Replaces the document with `text` using a brand new `EditorState`, so
   * history and selection from the previous document cannot leak into this one.
   */
  setDocument(text: string): void;
  /** Moves keyboard focus into the editor. */
  focus(): void;
  /** Runs CodeMirror's own undo command against the active view. */
  undo(): void;
  /** Runs CodeMirror's own redo command against the active view. */
  redo(): void;
  /** Registers the single receiver of `docChanged` notifications. */
  setDocumentChangeListener(listener: DocumentChangeListener | null): void;
}

/**
 * The view-binding surface used only by the `Editor` component.
 *
 * The component keeps owning the `EditorView` lifetime while the handle keeps
 * owning the document semantics, which is why the two are separate interfaces.
 */
export interface EditorAttachment {
  /**
   * Extensions every state created for this handle must include, so the handle
   * keeps receiving document changes after a `setDocument` reset.
   */
  readonly extensions: Extension;
  attach(view: EditorView): void;
  detach(view: EditorView): void;
}

/** A handle that the `Editor` component can bind a view to. */
export type AttachedEditorHandle = EditorHandle & EditorAttachment;

const NOT_ATTACHED_MESSAGE =
  "The editor handle is not attached to a CodeMirror view.";

class EditorHandleImpl implements EditorHandle, EditorAttachment {
  private view: EditorView | null = null;
  private changeListener: DocumentChangeListener | null = null;

  /**
   * `EditorView.updateListener` reads `changeListener` at call time, so one
   * extension instance can serve every state this handle ever creates.
   */
  readonly extensions: Extension = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      this.changeListener?.();
    }
  });

  attach(view: EditorView): void {
    this.view = view;
  }

  detach(view: EditorView): void {
    if (this.view === view) {
      this.view = null;
    }
  }

  isReady(): boolean {
    return this.view !== null;
  }

  getDocument(): Text {
    return this.requireView().state.doc;
  }

  setDocument(text: string): void {
    const view = this.requireView();
    view.setState(createEditorState(text, this.extensions));
  }

  focus(): void {
    this.requireView().focus();
  }

  undo(): void {
    undo(this.requireView());
  }

  redo(): void {
    redo(this.requireView());
  }

  setDocumentChangeListener(listener: DocumentChangeListener | null): void {
    this.changeListener = listener;
  }

  private requireView(): EditorView {
    if (this.view === null) {
      throw new Error(NOT_ATTACHED_MESSAGE);
    }
    return this.view;
  }
}

/** Creates the process-wide editor handle the application talks to. */
export function createEditorHandle(): AttachedEditorHandle {
  return new EditorHandleImpl();
}
