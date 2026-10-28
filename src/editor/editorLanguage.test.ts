import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { LanguageSupport } from "@codemirror/language";

import {
  editorLanguage,
  editorLanguageFacet,
  findLanguageDescription,
  getBasename,
  languageLoaderPlugin,
  reconfigureEditorLanguage,
} from "./editorLanguage";

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Creates a mock view harness where dispatch updates state and invokes plugin.update,
 * replicating real CodeMirror EditorView dispatch cycles.
 */
function createMockViewHarness(initialState: EditorState) {
  let state = initialState;
  let plugin: any;

  const mockView: any = {
    get state() {
      return state;
    },
    dispatch: vi.fn((trSpec: any) => {
      const prev = state;
      state = state.update(trSpec).state;
      if (plugin) {
        plugin.update({
          startState: prev,
          state,
          view: mockView,
          docChanged: prev.doc !== state.doc,
          selectionSet: !prev.selection.eq(state.selection),
        });
      }
    }),
  };

  plugin = (languageLoaderPlugin as any).create(mockView);

  return {
    get state() {
      return state;
    },
    mockView,
    plugin,
  };
}

describe("getBasename path compatibility", () => {
  it("extracts basename from Unix paths", () => {
    expect(getBasename("/home/user/project/main.ts")).toBe("main.ts");
    expect(getBasename("/var/log/syslog")).toBe("syslog");
  });

  it("extracts basename from Windows paths", () => {
    expect(getBasename("C:\\Users\\User\\project\\index.tsx")).toBe("index.tsx");
    expect(getBasename("D:\\data\\file.py")).toBe("file.py");
  });

  it("extracts basename from mixed separator paths", () => {
    expect(getBasename("C:/Users\\User/project\\file.rs")).toBe("file.rs");
  });

  it("handles bare filenames without directory path", () => {
    expect(getBasename("Makefile")).toBe("Makefile");
    expect(getBasename("Dockerfile")).toBe("Dockerfile");
    expect(getBasename("test.json")).toBe("test.json");
  });

  it("returns empty string for null, undefined, empty, or trailing slash paths", () => {
    expect(getBasename(null)).toBe("");
    expect(getBasename(undefined)).toBe("");
    expect(getBasename("")).toBe("");
    expect(getBasename("C:\\Users\\User\\")).toBe("");
    expect(getBasename("/home/user/")).toBe("");
  });
});

describe("findLanguageDescription official catalog matching", () => {
  it("recognizes standard programming and markup extensions", () => {
    expect(findLanguageDescription("app.ts")?.name).toBe("TypeScript");
    expect(findLanguageDescription("app.tsx")?.name).toBe("TSX");
    expect(findLanguageDescription("data.json")?.name).toBe("JSON");
    expect(findLanguageDescription("script.py")?.name).toBe("Python");
    expect(findLanguageDescription("lib.rs")?.name).toBe("Rust");
    expect(findLanguageDescription("doc.md")?.name).toBe("Markdown");
    expect(findLanguageDescription("page.html")?.name).toBe("HTML");
    expect(findLanguageDescription("style.css")?.name).toBe("CSS");
    expect(findLanguageDescription("query.sql")?.name).toBe("SQL");
    expect(findLanguageDescription("config.yaml")?.name).toBe("YAML");
    expect(findLanguageDescription("main.cpp")?.name).toBe("C++");
  });

  it("recognizes full Windows and Unix paths", () => {
    expect(findLanguageDescription("C:\\Users\\User\\code\\main.rs")?.name).toBe("Rust");
    expect(findLanguageDescription("/home/user/project/script.py")?.name).toBe("Python");
    expect(findLanguageDescription("D:\\data\\config.json")?.name).toBe("JSON");
  });

  it("recognizes extensionless special files in official catalog", () => {
    expect(findLanguageDescription("Dockerfile")?.name).toBe("Dockerfile");
    expect(findLanguageDescription("C:\\repo\\Dockerfile")?.name).toBe("Dockerfile");
    expect(findLanguageDescription("CMakeLists.txt")?.name).toBe("CMake");
  });

  it("returns null for plain text, unknown extensions, null, and empty string", () => {
    expect(findLanguageDescription("notes.txt")).toBeNull();
    expect(findLanguageDescription("file.unknown_xyz_123")).toBeNull();
    expect(findLanguageDescription(null)).toBeNull();
    expect(findLanguageDescription("")).toBeNull();
  });
});

describe("editorLanguage and reconfigureEditorLanguage state integration", () => {
  it("initializes EditorState with correct metadata for recognizable language", () => {
    const state = EditorState.create({
      extensions: [editorLanguage("main.py")],
    });
    const meta = state.facet(editorLanguageFacet);
    expect(meta.filename).toBe("main.py");
    expect(meta.name).toBe("Python");
    expect(meta.loaded).toBe(false);
  });

  it("initializes EditorState as plain text when filename is null or unrecognized", () => {
    const stateNull = EditorState.create({
      extensions: [editorLanguage(null)],
    });
    expect(stateNull.facet(editorLanguageFacet)).toEqual({
      filename: null,
      name: null,
      loaded: false,
    });

    const stateTxt = EditorState.create({
      extensions: [editorLanguage("notes.txt")],
    });
    expect(stateTxt.facet(editorLanguageFacet)).toEqual({
      filename: "notes.txt",
      name: null,
      loaded: false,
    });
  });

  it("reconfigures language via reconfigureEditorLanguage StateEffect", () => {
    const state = EditorState.create({
      extensions: [editorLanguage("notes.txt")],
    });
    expect(state.facet(editorLanguageFacet).name).toBeNull();

    const tr = state.update({
      effects: reconfigureEditorLanguage("script.py"),
    });
    const updatedMeta = tr.state.facet(editorLanguageFacet);
    expect(updatedMeta.filename).toBe("script.py");
    expect(updatedMeta.name).toBe("Python");
    expect(updatedMeta.loaded).toBe(false);

    // Reconfiguring back to null reverts to plain text
    const trReset = tr.state.update({
      effects: reconfigureEditorLanguage(null),
    });
    const resetMeta = trReset.state.facet(editorLanguageFacet);
    expect(resetMeta.filename).toBeNull();
    expect(resetMeta.name).toBeNull();
    expect(resetMeta.loaded).toBe(false);
  });

  it("uses native cached support immediately when desc.support is already present", () => {
    const pythonDesc = findLanguageDescription("script.py")!;
    const savedSupport = pythonDesc.support;
    const mockSupport = { extension: [] } as unknown as LanguageSupport;

    try {
      pythonDesc.support = mockSupport;

      const state = EditorState.create({
        extensions: [editorLanguage("script.py")],
      });
      const meta = state.facet(editorLanguageFacet);
      expect(meta.name).toBe("Python");
      expect(meta.loaded).toBe(true);

      const stateEmpty = EditorState.create({
        extensions: [editorLanguage(null)],
      });
      const tr = stateEmpty.update({
        effects: reconfigureEditorLanguage("script.py"),
      });
      expect(tr.state.facet(editorLanguageFacet)).toEqual({
        filename: "script.py",
        name: "Python",
        loaded: true,
      });
    } finally {
      pythonDesc.support = savedSupport;
    }
  });
});

describe("languageLoaderPlugin async lifecycle, failure fallback, and no-retry behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initiates loading and applies support on successful load", async () => {
    const pyDesc = findLanguageDescription("script.py")!;
    const deferred = createDeferred<LanguageSupport>();
    const mockSupport = { extension: [] } as unknown as LanguageSupport;
    const loadSpy = vi.spyOn(pyDesc, "load").mockReturnValue(deferred.promise);

    const initialState = EditorState.create({
      extensions: [editorLanguage("script.py")],
    });
    const { mockView, plugin } = createMockViewHarness(initialState);
    await flushAsync();

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(mockView.state.facet(editorLanguageFacet).loaded).toBe(false);

    deferred.resolve(mockSupport);
    await flushAsync();

    expect(mockView.state.facet(editorLanguageFacet).loaded).toBe(true);
    expect(mockView.state.facet(editorLanguageFacet).name).toBe("Python");

    plugin.destroy();
  });

  it("does not overwrite edits made to EditorState during async loading", async () => {
    const pyDesc = findLanguageDescription("script.py")!;
    const deferred = createDeferred<LanguageSupport>();
    const mockSupport = { extension: [] } as unknown as LanguageSupport;
    vi.spyOn(pyDesc, "load").mockReturnValue(deferred.promise);

    const initialState = EditorState.create({
      doc: "initial text",
      extensions: [editorLanguage("script.py")],
    });
    const { mockView, plugin } = createMockViewHarness(initialState);

    // User types while loading is in-flight
    mockView.dispatch({
      changes: { from: 12, insert: " - edited while loading" },
    });
    expect(mockView.state.doc.toString()).toBe("initial text - edited while loading");

    deferred.resolve(mockSupport);
    await flushAsync();

    expect(mockView.state.facet(editorLanguageFacet).loaded).toBe(true);
    expect(mockView.state.doc.toString()).toBe("initial text - edited while loading");

    plugin.destroy();
  });

  it("discards async result if filename changed before load completed", async () => {
    const pyDesc = findLanguageDescription("file.py")!;
    const rustDesc = findLanguageDescription("file.rs")!;

    const deferredPy = createDeferred<LanguageSupport>();
    const deferredRust = createDeferred<LanguageSupport>();

    vi.spyOn(pyDesc, "load").mockReturnValue(deferredPy.promise);
    vi.spyOn(rustDesc, "load").mockReturnValue(deferredRust.promise);

    const initialState = EditorState.create({
      extensions: [editorLanguage("file.py")],
    });
    const { mockView, plugin } = createMockViewHarness(initialState);

    // Switch to file.rs before file.py completes
    mockView.dispatch({
      effects: reconfigureEditorLanguage("file.rs"),
    });
    expect(mockView.state.facet(editorLanguageFacet).filename).toBe("file.rs");

    // file.py resolves late
    deferredPy.resolve({ extension: [] } as unknown as LanguageSupport);
    await flushAsync();

    // Late python result must NOT be applied to file.rs
    expect(mockView.state.facet(editorLanguageFacet).name).toBe("Rust");
    expect(mockView.state.facet(editorLanguageFacet).loaded).toBe(false);

    // file.rs resolves
    const mockSupportRust = { extension: [] } as unknown as LanguageSupport;
    deferredRust.resolve(mockSupportRust);
    await flushAsync();

    expect(mockView.state.facet(editorLanguageFacet).name).toBe("Rust");
    expect(mockView.state.facet(editorLanguageFacet).loaded).toBe(true);

    plugin.destroy();
  });

  it("discards async result if plugin is destroyed before load completed", async () => {
    const pyDesc = findLanguageDescription("script.py")!;
    const deferred = createDeferred<LanguageSupport>();
    vi.spyOn(pyDesc, "load").mockReturnValue(deferred.promise);

    const initialState = EditorState.create({
      extensions: [editorLanguage("script.py")],
    });
    const { mockView, plugin } = createMockViewHarness(initialState);

    // Plugin destroyed
    plugin.destroy();

    // Late resolution
    deferred.resolve({ extension: [] } as unknown as LanguageSupport);
    await flushAsync();

    // Dispatch was called 0 times on destroyed plugin
    expect(mockView.dispatch).not.toHaveBeenCalled();
  });

  it("catches synchronous exception thrown by desc.load() and safely falls back to plain text", async () => {
    const pyDesc = findLanguageDescription("sync-fail.py")!;
    const loadSpy = vi.spyOn(pyDesc, "load").mockImplementation(() => {
      throw new Error("Synchronous parse failure");
    });

    const initialState = EditorState.create({
      extensions: [editorLanguage("sync-fail.py")],
    });
    const { mockView, plugin } = createMockViewHarness(initialState);
    await flushAsync();

    expect(loadSpy).toHaveBeenCalledTimes(1);
    const meta = mockView.state.facet(editorLanguageFacet);
    expect(meta.name).toBeNull();
    expect(meta.loaded).toBe(false);

    // Subsequent edit still does not retry
    mockView.dispatch({ changes: { from: 0, insert: "text" } });
    await flushAsync();
    expect(loadSpy).toHaveBeenCalledTimes(1);

    plugin.destroy();
  });

  it("catches load failure, falls back to plain text, and does not retry on subsequent updates or edits", async () => {
    const pyDesc = findLanguageDescription("script.py")!;
    const deferred = createDeferred<LanguageSupport>();
    const loadSpy = vi.spyOn(pyDesc, "load").mockReturnValue(deferred.promise);

    const initialState = EditorState.create({
      doc: "print('hello')",
      extensions: [editorLanguage("script.py")],
    });
    const { mockView, plugin } = createMockViewHarness(initialState);
    await flushAsync();

    // Initially scheduled one load
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // Reject load with an error (e.g. network/dynamic import failure)
    deferred.reject(new Error("Dynamic chunk import failed"));
    await flushAsync();

    // 1. Verify fallback to plain text: name cleared to null, loaded remains false
    const meta = mockView.state.facet(editorLanguageFacet);
    expect(meta.filename).toBe("script.py");
    expect(meta.name).toBeNull();
    expect(meta.loaded).toBe(false);

    // 2. Critical: verify plugin.update from the failure dispatch did NOT trigger another load
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // 3. User types in document after failure
    mockView.dispatch({
      changes: { from: 14, insert: "\n# another line" },
    });
    await flushAsync();

    // Load count must STILL remain 1 (no retry on typing)
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // 4. User moves cursor/selection
    mockView.dispatch({
      selection: EditorSelection.cursor(5),
    });
    await flushAsync();

    // Load count must STILL remain 1 (no retry on selection)
    expect(loadSpy).toHaveBeenCalledTimes(1);

    plugin.destroy();
  });
});