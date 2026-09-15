import { Editor } from "../editor/Editor";

import "../styles/global.css";

/**
 * Application shell.
 *
 * Everything except the CodeMirror view lives here: layout and, later on,
 * menus, tabs and side panels. React owns the UI; the editor owns the document.
 */
export function App() {
  return (
    <div className="app">
      <header className="app__header">
        <span className="app__wordmark">Sorakada</span>
      </header>

      <main className="app__content">
        <Editor />
      </main>
    </div>
  );
}
