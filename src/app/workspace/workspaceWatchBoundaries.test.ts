/**
 * Static module-boundary audit for 006.
 *
 * The feature adds a second consumer of the filesystem watcher next to 005's.
 * The value of that split is entirely in the boundaries it preserves, and those
 * boundaries are structural: a module either imports another one or it does not.
 * Auditing the import graph here keeps the rule from surviving only as a review
 * comment (T044, T126).
 *
 * What must stay true:
 *
 * - the Workspace watcher may reach documents *only* through the narrow
 *   `WorkspaceDocumentPort` type declaration — never through `DocumentSession`
 *   internals or CodeMirror, because 006 must not touch editor text (FR-116);
 * - the opened-document consumer stays Explorer-free and Workspace-free, so 005
 *   can never rescan a Tree and 006 can never validate a document directly;
 * - the generic watcher adapter knows nothing about either consumer.
 *
 * The sources are imported with Vite's `?raw` suffix, so this stays a pure
 * static check with no filesystem access and no Node typings.
 */

import { describe, expect, it } from "vitest";

import batcherSource from "./workspaceWatchBatcher.ts?raw";
import coordinatorSource from "./workspaceWatchCoordinator.ts?raw";
import documentConsumerSource from "../document/openedDocumentWatchCoordinator.ts?raw";
import watcherServiceSource from "../../services/filesystemWatcher.ts?raw";

/** Every module specifier a source file imports from. */
function importPaths(source: string): string[] {
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
}

/** The full text of every import statement in a source file. */
function importStatements(source: string): string[] {
  return [...source.matchAll(/import\s[^;]*?from\s+"[^"]+";/g)].map(
    (match) => match[0],
  );
}

describe("006 module boundaries", () => {
  it("keeps the Workspace watcher away from editor text and session internals", () => {
    for (const [name, source] of [
      ["workspaceWatchCoordinator.ts", coordinatorSource],
      ["workspaceWatchBatcher.ts", batcherSource],
    ] as const) {
      for (const path of importPaths(source)) {
        expect(path, `${name} must not import ${path}`).not.toContain("codemirror");
        expect(path, `${name} must not import ${path}`).not.toContain("editor/");
        expect(path, `${name} must not import ${path}`).not.toContain(
          "documentSession",
        );
      }

      // The document lifecycle may only be reached as a declared type: 006
      // requests relocation, DocumentManager owns it (FR-056).
      for (const statement of importStatements(source)) {
        if (statement.includes("/document/documentManager")) {
          expect(statement.startsWith("import type")).toBe(true);
        }
      }

      // No direct mutation of the facts 006 does not own.
      expect(source).not.toMatch(/\.editorState\s*=/);
      expect(source).not.toMatch(/\.savedBaseline\s*=/);
      expect(source).not.toMatch(/new EditorState/);
    }
  });

  it("keeps the opened-document consumer free of Explorer and Workspace code", () => {
    for (const path of importPaths(documentConsumerSource)) {
      expect(path, `005 must not import ${path}`).not.toContain("/explorer/");
      expect(path, `005 must not import ${path}`).not.toContain("/workspace/");
    }
  });

  it("keeps the generic watcher adapter consumer-agnostic", () => {
    for (const path of importPaths(watcherServiceSource)) {
      expect(path, `the watcher adapter must not import ${path}`).not.toContain(
        "/app/",
      );
      expect(path, `the watcher adapter must not import ${path}`).not.toContain(
        "explorer",
      );
      expect(path, `the watcher adapter must not import ${path}`).not.toContain(
        "workspace/",
      );
    }
  });
});
