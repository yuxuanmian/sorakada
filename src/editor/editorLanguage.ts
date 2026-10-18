import {
  Compartment,
  type Extension,
  Facet,
  type StateEffect,
} from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  LanguageDescription,
  type LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

/**
 * Metadata about the language currently configured in the editor state.
 */
export interface EditorLanguageMetadata {
  /** The full path or filename passed to the language extension. */
  readonly filename: string | null;
  /** The matched language name (e.g. 'TypeScript', 'Python'), or null if plain text / failed. */
  readonly name: string | null;
  /** Whether the LanguageSupport extension is loaded and active in the compartment. */
  readonly loaded: boolean;
}

const DEFAULT_METADATA: EditorLanguageMetadata = Object.freeze({
  filename: null,
  name: null,
  loaded: false,
});

/**
 * Facet holding the current language metadata.
 *
 * Placed inside `languageCompartment` alongside the language extension so that
 * reconfiguring the compartment atomically updates both the active language grammar
 * and the metadata facet without requiring any separate StateField.
 */
export const editorLanguageFacet = Facet.define<
  EditorLanguageMetadata,
  EditorLanguageMetadata
>({
  combine: (values) =>
    values.length > 0 ? values[values.length - 1] : DEFAULT_METADATA,
});

/**
 * The Compartment isolating the active language extension and its metadata.
 */
export const languageCompartment = new Compartment();

/**
 * Extracts the file basename from a path string, supporting both Windows (`\`)
 * and Unix (`/`) directory separators.
 */
export function getBasename(path: string | null | undefined): string {
  if (!path) {
    return "";
  }
  const match = path.match(/[^/\\]+$/);
  return match ? match[0] : "";
}

/**
 * Finds a matching `LanguageDescription` from the official language catalog for the
 * given filename or path.
 *
 * Returns `null` if the filename is null/empty or unrecognized.
 */
export function findLanguageDescription(
  filename: string | null | undefined,
): LanguageDescription | null {
  const base = getBasename(filename);
  if (!base) {
    return null;
  }
  return LanguageDescription.matchFilename(languages, base);
}

function buildLanguageExtension(
  filename: string | null,
  support: LanguageSupport | null,
  desc: LanguageDescription | null,
): Extension {
  return [
    editorLanguageFacet.of({
      filename,
      name: desc?.name ?? null,
      loaded: support !== null,
    }),
    support ? support.extension : [],
  ];
}

class LanguageLoaderPluginValue {
  private isDestroyed = false;
  private inFlightFilename: string | null = null;

  constructor(readonly view: EditorView) {
    this.scheduleLoad(view);
  }

  update(update: ViewUpdate): void {
    const prevMeta = update.startState.facet(editorLanguageFacet);
    const currMeta = update.state.facet(editorLanguageFacet);
    // Only schedule a load if the filename or name changed to an unloaded language.
    // Plain text / failed states (currMeta.name === null), ordinary typing, or selection
    // changes never trigger a load or retry.
    if (
      (prevMeta.filename !== currMeta.filename || prevMeta.name !== currMeta.name) &&
      currMeta.name !== null &&
      !currMeta.loaded
    ) {
      this.scheduleLoad(update.view);
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.inFlightFilename = null;
  }

  private scheduleLoad(view: EditorView): void {
    const meta = view.state.facet(editorLanguageFacet);
    const targetFilename = meta.filename;

    if (!targetFilename || meta.loaded || meta.name === null) {
      this.inFlightFilename = null;
      return;
    }

    if (this.inFlightFilename === targetFilename) {
      return;
    }

    const desc = findLanguageDescription(targetFilename);
    if (!desc) {
      this.inFlightFilename = null;
      return;
    }

    this.inFlightFilename = targetFilename;

    Promise.resolve()
      .then(() => desc.load())
      .then((support) => {
        if (this.inFlightFilename === targetFilename) {
          this.inFlightFilename = null;
        }
        if (this.isDestroyed) {
          return;
        }
        const currentMeta = view.state.facet(editorLanguageFacet);
        if (currentMeta.filename !== targetFilename || currentMeta.loaded) {
          return;
        }
        view.dispatch({
          effects: languageCompartment.reconfigure(
            buildLanguageExtension(targetFilename, support, desc),
          ),
        });
      })
      .catch((_err) => {
        if (this.inFlightFilename === targetFilename) {
          this.inFlightFilename = null;
        }
        if (this.isDestroyed) {
          return;
        }
        const currentMeta = view.state.facet(editorLanguageFacet);
        if (currentMeta.filename !== targetFilename) {
          return;
        }
        // Fallback to plain text on error: name is set to null, which prevents retry loops.
        view.dispatch({
          effects: languageCompartment.reconfigure(
            buildLanguageExtension(targetFilename, null, null),
          ),
        });
      });
  }
}

export const languageLoaderPlugin = ViewPlugin.fromClass(
  LanguageLoaderPluginValue,
);

/**
 * Creates the complete language extension bundle for a document state.
 *
 * Installs:
 * - The language compartment with initial metadata and (if already loaded) grammar
 * - The syntax highlighting style (`oneDarkHighlightStyle`)
 * - The dynamic language loader plugin
 *
 * @param filename The initial filename or path for the document, or null for untitled/plain text.
 */
export function editorLanguage(filename: string | null = null): Extension {
  const desc = findLanguageDescription(filename);
  const support = desc?.support ?? null;
  return [
    languageCompartment.of(buildLanguageExtension(filename, support, desc)),
    syntaxHighlighting(oneDarkHighlightStyle),
    languageLoaderPlugin,
  ];
}

/**
 * Returns a native CodeMirror `StateEffect` to reconfigure the language for a new filename.
 *
 * Can be dispatched directly via `view.dispatch({ effects: reconfigureEditorLanguage(newPath) })`
 * or applied to an `EditorState` via `state.update({ effects: reconfigureEditorLanguage(newPath) })`.
 *
 * If the language's `LanguageSupport` is already cached on its `LanguageDescription`, it is
 * installed immediately. If not yet loaded, plain text is installed initially and the
 * loader plugin asynchronously fetches it. If `filename` is null or unrecognized, previous
 * language support is cleared to plain text.
 *
 * @param filename The new filename or path, or null to revert to plain text.
 */
export function reconfigureEditorLanguage(
  filename: string | null,
): StateEffect<unknown> {
  const desc = findLanguageDescription(filename);
  const support = desc?.support ?? null;
  return languageCompartment.reconfigure(
    buildLanguageExtension(filename, support, desc),
  );
}