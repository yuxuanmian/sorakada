/**
 * T166: the Footer projection matrix.
 *
 * FR-075..FR-077 turn into a set of states that must each render something
 * sensible: nothing at all, Workspace-only, untitled, an inside file (with a
 * breadcrumb derived from canonical relation), an outside file, a rebound file and
 * the EOL variants. All of it is pure, so it is checked here rather than by
 * looking at the window.
 */

import { describe, expect, it } from "vitest";

import { NEW_DOCUMENT_FORMAT, type TextFormat } from "../document/documentSession";
import {
  breadcrumbSegments,
  formatStatusItems,
  projectFooter,
  type FooterDocument,
  type FooterWorkspace,
} from "./footerProjection";

const workspace: FooterWorkspace = {
  rootPath: "C:\\work",
  comparisonKey: "c:\\work",
  displayName: "work",
};

function document(overrides: Partial<FooterDocument> = {}): FooterDocument {
  return {
    displayName: "a.ts",
    path: "C:\\work\\src\\a.ts",
    pathKey: "c:\\work\\src\\a.ts",
    format: { ...NEW_DOCUMENT_FORMAT },
    ...overrides,
  };
}

function format(overrides: Partial<TextFormat> = {}): TextFormat {
  return { ...NEW_DOCUMENT_FORMAT, ...overrides };
}

describe("Footer left context", () => {
  it("is minimal with neither a Workspace nor a document", () => {
    expect(projectFooter({ workspace: null, document: null })).toEqual({
      left: { kind: "empty" },
      right: [],
    });
  });

  it("shows Workspace context with no active document", () => {
    const projection = projectFooter({ workspace, document: null });
    expect(projection.left).toEqual({
      kind: "workspace",
      workspaceName: "work",
      title: "C:\\work",
    });
    expect(projection.right).toEqual([]);
  });

  it("shows an untitled document by name", () => {
    const projection = projectFooter({
      workspace,
      document: document({
        displayName: "Untitled1",
        path: null,
        pathKey: null,
      }),
    });
    expect(projection.left).toEqual({
      kind: "untitled",
      displayName: "Untitled1",
    });
  });

  it("shows the Workspace name plus the relative path for an inside file", () => {
    const projection = projectFooter({
      workspace,
      document: document(),
    });
    expect(projection.left).toEqual({
      kind: "inside",
      workspaceName: "work",
      segments: ["src", "a.ts"],
      title: "C:\\work\\src\\a.ts",
    });
  });

  it("uses the user-facing spelling for the displayed components", () => {
    const projection = projectFooter({
      workspace: { ...workspace, comparisonKey: "c:\\work" },
      document: document({
        path: "C:\\Work\\Src\\A.ts",
        pathKey: "c:\\work\\src\\a.ts",
      }),
    });
    expect(projection.left).toMatchObject({
      kind: "inside",
      segments: ["Src", "A.ts"],
    });
  });

  it("shows an outside file's own path and creates no Workspace", () => {
    const projection = projectFooter({
      workspace,
      document: document({
        displayName: "other.ts",
        path: "D:\\elsewhere\\other.ts",
        pathKey: "d:\\elsewhere\\other.ts",
      }),
    });
    expect(projection.left).toEqual({
      kind: "outside",
      segments: ["D:", "elsewhere", "other.ts"],
      title: "D:\\elsewhere\\other.ts",
    });
  });

  it("treats a sibling with a shared name prefix as outside (FR-075)", () => {
    const projection = projectFooter({
      workspace,
      document: document({
        path: "C:\\work-old\\a.ts",
        pathKey: "c:\\work-old\\a.ts",
      }),
    });
    expect(projection.left.kind).toBe("outside");
  });

  it("shows an outside file's path when no Workspace is open", () => {
    const projection = projectFooter({
      workspace: null,
      document: document({ path: "D:\\x\\a.ts", pathKey: "d:\\x\\a.ts" }),
    });
    expect(projection.left).toMatchObject({ kind: "outside" });
  });

  it("updates after Save As rebinds the document", () => {
    const before = projectFooter({ workspace, document: document() });
    const after = projectFooter({
      workspace,
      document: document({
        displayName: "b.ts",
        path: "C:\\work\\lib\\b.ts",
        pathKey: "c:\\work\\lib\\b.ts",
      }),
    });

    expect(before.left).toMatchObject({ segments: ["src", "a.ts"] });
    expect(after.left).toMatchObject({ segments: ["lib", "b.ts"] });
  });

  it("updates after the document moves out of the Workspace", () => {
    const projection = projectFooter({
      workspace,
      document: document({
        path: "D:\\other\\a.ts",
        pathKey: "d:\\other\\a.ts",
      }),
    });
    expect(projection.left.kind).toBe("outside");
  });

  it("shows only the file name when the file is a Workspace-root child", () => {
    const projection = projectFooter({
      workspace,
      document: document({
        displayName: "root.ts",
        path: "C:\\work\\root.ts",
        pathKey: "c:\\work\\root.ts",
      }),
    });
    expect(projection.left).toMatchObject({
      kind: "inside",
      segments: ["root.ts"],
    });
  });
});

describe("breadcrumbSegments", () => {
  it("returns null when the document has no disk path", () => {
    expect(
      breadcrumbSegments(workspace, document({ path: null, pathKey: null })),
    ).toBeNull();
  });

  it("returns an empty chain for the Workspace root itself", () => {
    expect(
      breadcrumbSegments(
        workspace,
        document({ path: "C:\\work", pathKey: "c:\\work" }),
      ),
    ).toEqual([]);
  });

  it("derives depth from the canonical key, not from the display string", () => {
    // A display path with a redundant separator still yields the right tail.
    expect(
      breadcrumbSegments(
        workspace,
        document({
          path: "C:\\work\\\\src\\a.ts",
          pathKey: "c:\\work\\src\\a.ts",
        }),
      ),
    ).toEqual(["src", "a.ts"]);
  });
});

describe("Footer right status (T171)", () => {
  it("shows UTF-8 and the preferred line ending", () => {
    expect(formatStatusItems(format())).toEqual([
      { id: "encoding", label: "UTF-8", title: "Encoding: UTF-8" },
      { id: "line-ending", label: "CRLF", title: "Line ending on save: CRLF" },
    ]);
  });

  it("shows LF for a document that prefers LF", () => {
    const items = formatStatusItems(
      format({ detectedLineEnding: "lf", preferredLineEnding: "lf" }),
    );
    expect(items.find((item) => item.id === "line-ending")?.label).toBe("LF");
  });

  it("reports a UTF-8 BOM separately from plain UTF-8", () => {
    expect(formatStatusItems(format({ bom: "utf8" }))[0].label).toBe(
      "UTF-8 BOM",
    );
  });

  it("keeps the preferred ending for a mixed-EOL document", () => {
    const items = formatStatusItems(
      format({ detectedLineEnding: "mixed", preferredLineEnding: "crlf" }),
    );
    expect(items.find((item) => item.id === "line-ending")?.label).toBe("CRLF");
  });

  it("is empty without an active document", () => {
    expect(projectFooter({ workspace, document: null }).right).toEqual([]);
    expect(projectFooter({ workspace: null, document: null }).right).toEqual([]);
  });

  it("is a read-only projection of the session format", () => {
    const source = format({ preferredLineEnding: "lf" });
    const items = formatStatusItems(source);
    expect(source.preferredLineEnding).toBe("lf");
    expect(items.every((item) => typeof item.label === "string")).toBe(true);
  });
});
