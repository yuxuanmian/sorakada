/**
 * T104/T105/T111: Explorer quick-search matching and the direct-type trigger.
 *
 * FR-047 makes two claims worth pinning: matching happens only over the visible
 * projection (so it cannot read), and identity is a logical row key (so a watcher
 * update cannot make the UI move to the wrong row).
 */

import { describe, expect, it } from "vitest";

import type { ExplorerState } from "./explorerModel";
import {
  flattenVisibleExplorerRows,
  type VisibleExplorerRow,
} from "./explorerProjection";
import {
  matchVisibleRowKeys,
  matchesQuery,
  recommendMatchKey,
  selectableMatchPath,
  stepMatchKey,
  typeToSearchSeed,
  type TypeToSearchContext,
} from "./explorerQuickSearch";

function state(): ExplorerState {
  const file = (name: string, parent: string) => ({
    name,
    path: `${parent}\\${name}`,
    kind: "file" as const,
    isSymlink: false,
    objectIdentity: null,
  });

  return {
    contextId: "workspace-1",
    generation: 1,
    root: {
      name: "work",
      path: "C:\\work",
      kind: "directory",
      isSymlink: false,
      objectIdentity: null,
      expanded: true,
      loadState: "loaded",
      children: [
        {
          name: "src",
          path: "C:\\work\\src",
          kind: "directory",
          isSymlink: false,
          objectIdentity: null,
          expanded: true,
          loadState: "loaded",
          children: [file("Main.ts", "C:\\work\\src"), file("util.ts", "C:\\work\\src")],
        },
        file("README.md", "C:\\work"),
      ],
    },
    selectedPath: null,
    inlineEdit: null,
    rootUnavailable: false,
  };
}

function rows(): VisibleExplorerRow[] {
  return flattenVisibleExplorerRows(state());
}

const noTextOwner: TypeToSearchContext = {
  inlineEditorFocused: false,
  searchInputFocused: false,
  otherTextControlFocused: false,
};

const key = (overrides: Partial<Parameters<typeof typeToSearchSeed>[0]> = {}) => ({
  key: "a",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...overrides,
});

describe("matchVisibleRowKeys", () => {
  it("matches a file name case-insensitively", () => {
    expect(matchVisibleRowKeys(rows(), "main")).toEqual(["C:\\work\\src\\Main.ts"]);
    expect(matchVisibleRowKeys(rows(), "MAIN")).toEqual(["C:\\work\\src\\Main.ts"]);
  });

  it("matches on the logical path so a folder narrows the list", () => {
    expect(matchVisibleRowKeys(rows(), "src\\")).toEqual([
      "C:\\work\\src\\Main.ts",
      "C:\\work\\src\\util.ts",
    ]);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(matchVisibleRowKeys(rows(), "")).toEqual([]);
    expect(matchVisibleRowKeys(rows(), "   ")).toEqual([]);
  });

  it("preserves projection order", () => {
    expect(matchVisibleRowKeys(rows(), ".")).toEqual([
      "C:\\work\\src\\Main.ts",
      "C:\\work\\src\\util.ts",
      "C:\\work\\README.md",
    ]);
  });

  it("matches nothing when the projection is empty", () => {
    expect(matchVisibleRowKeys([], "main")).toEqual([]);
  });

  it("matches a notice row by its message", () => {
    const withNotice: ExplorerState = {
      ...state(),
      root: {
        name: "work",
        path: "C:\\work",
        kind: "directory",
        isSymlink: false,
        objectIdentity: null,
        expanded: true,
        loadState: "loaded",
        children: [
          {
            name: "broken",
            path: "C:\\work\\broken",
            kind: "directory",
            isSymlink: false,
            objectIdentity: null,
            expanded: true,
            loadState: "error",
            errorMessage: "The folder could not be read.",
          },
        ],
      },
    };
    const projection = flattenVisibleExplorerRows(withNotice);
    expect(matchVisibleRowKeys(projection, "could not")).toEqual([
      "C:\\work\\broken::notice:error",
    ]);
  });

  it("matches by label or path, never by anything else", () => {
    const row = rows()[1];
    expect(matchesQuery(row, "src")).toBe(true);
    expect(matchesQuery(row, "zzz")).toBe(false);
  });
});

describe("match identity across a projection change (T111, FR-048)", () => {
  it("keeps the current match while it is still a match", () => {
    const before = matchVisibleRowKeys(rows(), ".");
    expect(recommendMatchKey(before, "C:\\work\\src\\util.ts")).toBe(
      "C:\\work\\src\\util.ts",
    );
  });

  it("moves to the next valid match when the current one disappears", () => {
    const before = matchVisibleRowKeys(rows(), ".");
    // The matched node was deleted by a watcher update.
    const after = before.filter((key) => key !== "C:\\work\\src\\Main.ts");
    expect(recommendMatchKey(after, "C:\\work\\src\\Main.ts")).toBe(
      "C:\\work\\src\\util.ts",
    );
  });

  it("clears instead of pointing at a stale index when nothing matches", () => {
    expect(recommendMatchKey([], "C:\\work\\src\\Main.ts")).toBeNull();
  });

  it("steps forward and back with wrap-around", () => {
    const matches = ["a", "b", "c"];
    expect(stepMatchKey(matches, "a", 1)).toBe("b");
    expect(stepMatchKey(matches, "c", 1)).toBe("a");
    expect(stepMatchKey(matches, "a", -1)).toBe("c");
    expect(stepMatchKey(matches, null, 1)).toBe("a");
    expect(stepMatchKey(matches, null, -1)).toBe("c");
    expect(stepMatchKey([], "a", 1)).toBeNull();
  });
});

describe("selectableMatchPath (T226, US3/AC3)", () => {
  it("resolves an entry row's logical path so the match can be selected", () => {
    expect(
      selectableMatchPath(rows(), "C:\\work\\src\\Main.ts"),
    ).toBe("C:\\work\\src\\Main.ts");
  });

  it("has no selection for a sentinel row", () => {
    const withNotice: ExplorerState = {
      ...state(),
      root: {
        name: "work",
        path: "C:\\work",
        kind: "directory",
        isSymlink: false,
        objectIdentity: null,
        expanded: true,
        loadState: "loaded",
        children: [
          {
            name: "broken",
            path: "C:\\work\\broken",
            kind: "directory",
            isSymlink: false,
            objectIdentity: null,
            expanded: true,
            loadState: "error",
            errorMessage: "The folder could not be read.",
          },
        ],
      },
    };
    const projection = flattenVisibleExplorerRows(withNotice);
    const noticeKey = matchVisibleRowKeys(projection, "could not")[0];

    expect(noticeKey).toBe("C:\\work\\broken::notice:error");
    expect(selectableMatchPath(projection, noticeKey)).toBeNull();
  });

  it("has no selection for the inline-create row", () => {
    const withEditor: ExplorerState = {
      ...state(),
      inlineEdit: {
        type: "create-file",
        parentPath: "C:\\work\\src",
        draftName: "new.ts",
      },
    };
    const projection = flattenVisibleExplorerRows(withEditor);
    const inlineKey = projection.find((row) => row.kind === "inline")?.key;
    expect(inlineKey).toBeDefined();
    expect(selectableMatchPath(projection, inlineKey ?? null)).toBeNull();
  });

  it("has nothing to select without a current match", () => {
    expect(selectableMatchPath(rows(), null)).toBeNull();
  });

  it("ignores a key that is no longer in the projection", () => {
    expect(selectableMatchPath(rows(), "C:\\work\\gone.ts")).toBeNull();
  });
});

describe("typeToSearchSeed", () => {
  it("accepts a printable character", () => {
    expect(typeToSearchSeed(key({ key: "a" }), noTextOwner)).toBe("a");
    expect(typeToSearchSeed(key({ key: "Z" }), noTextOwner)).toBe("Z");
    expect(typeToSearchSeed(key({ key: "7" }), noTextOwner)).toBe("7");
    expect(typeToSearchSeed(key({ key: " " }), noTextOwner)).toBe(" ");
  });

  it("ignores shortcuts so Ctrl+N and Alt+key are never stolen", () => {
    expect(typeToSearchSeed(key({ ctrlKey: true }), noTextOwner)).toBeNull();
    expect(typeToSearchSeed(key({ metaKey: true }), noTextOwner)).toBeNull();
    expect(typeToSearchSeed(key({ altKey: true }), noTextOwner)).toBeNull();
  });

  it("ignores non-typing keys", () => {
    for (const typed of ["Enter", "Escape", "F2", "Delete", "ArrowDown", "Dead"]) {
      expect(typeToSearchSeed(key({ key: typed }), noTextOwner), typed).toBeNull();
    }
  });

  it("never hijacks IME composition (FR-050)", () => {
    expect(
      typeToSearchSeed(key({ key: "a", isComposing: true }), noTextOwner),
    ).toBeNull();
  });

  it("never hijacks a control that already owns text (FR-050)", () => {
    expect(
      typeToSearchSeed(key(), { ...noTextOwner, inlineEditorFocused: true }),
    ).toBeNull();
    expect(
      typeToSearchSeed(key(), { ...noTextOwner, searchInputFocused: true }),
    ).toBeNull();
    expect(
      typeToSearchSeed(key(), { ...noTextOwner, otherTextControlFocused: true }),
    ).toBeNull();
  });
});
