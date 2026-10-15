# Contract: Editor Bridge

**Feature**: `002-multi-document-tabs`

The editor bridge is the only application-layer object allowed to manipulate the live CodeMirror `EditorView`.

## Required surface

Conceptual TypeScript shape:

```ts
interface EditorHandle {
  readonly extensions: Extension;

  isReady(): boolean;
  attach(view: EditorView, documentId: DocumentId): void;
  detach(view: EditorView): void;

  getState(): EditorState;
  setState(documentId: DocumentId, state: EditorState): void;

  captureViewState(): DocumentViewState;
  restoreViewState(state: DocumentViewState): void;

  focus(): void;
  undo(): void;
  redo(): void;

  setStateUpdateListener(
    listener: ((documentId: DocumentId, state: EditorState, docChanged: boolean) => void) | null,
  ): void;
}
```

Exact method names may differ, but all behavioral guarantees below are mandatory.

## Identity-binding guarantee

Before a new state is installed into the shared view, the bridge must bind the target `documentId`:

```text
setState(targetId, targetState)
  boundDocumentId = targetId
  view.setState(targetState)
```

Any update notification produced by or after the state swap is therefore attributed to `targetId`, never the previously active id.

## Update listener guarantee

For each CodeMirror `ViewUpdate`:

```text
listener(boundDocumentId, update.state, update.docChanged)
```

The listener must not copy text into React state.

## View-state capture

002 minimum:

```ts
{
  scrollTop: view.scrollDOM.scrollTop,
  scrollLeft: view.scrollDOM.scrollLeft,
}
```

Restore after `setState`. If a measurement/animation-frame step is required for reliable restoration, keep it encapsulated inside the editor bridge rather than exposing CodeMirror DOM concerns to DocumentManager.

## Undo/Redo

Undo and redo continue to run against the one active view. Because each Tab restores its own `EditorState`, history remains document-local without separate application history stacks.

## Initial mount

`Editor.tsx` receives the manager's initial active document state/id. It creates exactly one `EditorView`, attaches it with the initial document id, and destroys it on component cleanup. React Strict Mode double-mount must not leak views/listeners.

## Appearance boundary

Every session state is created through the same editor state factory. The current appearance/theme extension must be behind an application-scoped reconfiguration boundary. No `DocumentSession` stores an independent user theme.
