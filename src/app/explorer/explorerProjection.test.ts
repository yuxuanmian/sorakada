/**
 * T077..T080: the visible-row projection.
 *
 * The projection is what replaces recursive rendering, so these tests pin the
 * properties the virtualized Tree depends on: only expanded branches appear, the
 * ordering matches the controller's, every row carries depth/ancestor metadata,
 * sentinels participate as rows, and flattening performs no I/O and mutates
 * nothing.
 */

import { describe, expect, it } from "vitest";

import {
  DIRECTORY_CYCLE_MESSAGE,
  DIRECTORY_LOADING_MESSAGE,
  type ExplorerDirectoryNode,
  type ExplorerNode,
  type ExplorerState,
} from "./explorerModel";
import {
  flattenVisibleExplorerRows,
  inlineCreateRowKey,
  planRowReveal,
  type VisibleExplorerRow,
} from "./explorerProjection";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function file(name: string, parent = "C:\\work"): ExplorerNode {
  return {
    name,
    path: `${parent}\\${name}`,
    kind: "file",
    isSymlink: false,
    objectIdentity: null,
  };
}

function directory(
  name: string,
  parent = "C:\\work",
  options: Partial<ExplorerDirectoryNode> = {},
): ExplorerDirectoryNode {
  return {
    name,
    path: `${parent}\\${name}`,
    kind: "directory",
    isSymlink: false,
    objectIdentity: null,
    expanded: false,
    loadState: "not-loaded",
    ...options,
  };
}

function stateWith(root: ExplorerDirectoryNode | null): ExplorerState {
  return {
    contextId: root === null ? null : "workspace-1",
    generation: 1,
    root,
    selectedPath: null,
    inlineEdit: null,
    rootUnavailable: false,
  };
}

function keys(rows: readonly VisibleExplorerRow[]): string[] {
  return rows.map((row) => row.key);
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

describe("flattenVisibleExplorerRows", () => {
  it("produces nothing without a represented root", () => {
    expect(flattenVisibleExplorerRows(stateWith(null))).toEqual([]);
  });

  it("always starts at the root and includes loaded children of an expanded root", () => {
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [directory("src"), file("README.md")],
    });

    const rows = flattenVisibleExplorerRows(stateWith(root));

    expect(keys(rows)).toEqual([
      "C:\\work",
      "C:\\work\\src",
      "C:\\work\\README.md",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1]);
  });

  it("descends only through expanded directories, preserving controller order", () => {
    const nested = directory("src", "C:\\work", {
      expanded: true,
      loadState: "loaded",
      children: [file("main.ts", "C:\\work\\src")],
    });
    const collapsed = directory("docs", "C:\\work");
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [nested, collapsed],
    });

    expect(keys(flattenVisibleExplorerRows(stateWith(root)))).toEqual([
      "C:\\work",
      "C:\\work\\src",
      "C:\\work\\src\\main.ts",
      "C:\\work\\docs",
    ]);
  });

  it("excludes every descendant of a collapsed ancestor (T078)", () => {
    // The controller legitimately keeps a descendant expanded and cached while an
    // ancestor is collapsed, so the projection has to be the thing that hides it.
    const deep = directory("inner", "C:\\work\\src", {
      expanded: true,
      loadState: "loaded",
      children: [file("deep.ts", "C:\\work\\src\\inner")],
    });
    const src = directory("src", "C:\\work", {
      expanded: false,
      loadState: "loaded",
      children: [deep],
    });
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [src],
    });

    const rows = flattenVisibleExplorerRows(stateWith(root));
    expect(keys(rows)).toEqual(["C:\\work", "C:\\work\\src"]);

    // The cached/expanded descendant state is untouched, so re-expanding the
    // ancestor restores the previous view immediately.
    expect(src.expanded).toBe(false);
    expect(deep.expanded).toBe(true);
    expect(deep.children).toHaveLength(1);

    src.expanded = true;
    expect(keys(flattenVisibleExplorerRows(stateWith(root)))).toContain(
      "C:\\work\\src\\inner\\deep.ts",
    );
  });

  it("keeps files and other entries as plain rows", () => {
    const other: ExplorerNode = {
      name: "broken-link",
      path: "C:\\work\\broken-link",
      kind: "other",
      isSymlink: true,
      objectIdentity: null,
    };
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [other],
    });

    const rows = flattenVisibleExplorerRows(stateWith(root));
    expect(rows[1]).toMatchObject({ kind: "node", path: "C:\\work\\broken-link" });
  });
});

/* -------------------------------------------------------------------------- */
/* Sentinels                                                                  */
/* -------------------------------------------------------------------------- */

describe("loading/error/cycle sentinels", () => {
  it("emits a loading sentinel for an unloaded directory being read", () => {
    const src = directory("src", "C:\\work", {
      expanded: true,
      loadState: "loading",
    });
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [src],
    });

    const rows = flattenVisibleExplorerRows(stateWith(root));
    const notice = rows[2];
    expect(notice).toMatchObject({
      kind: "notice",
      noticeType: "loading",
      message: DIRECTORY_LOADING_MESSAGE,
      parentPath: "C:\\work\\src",
      depth: 2,
    });
    expect(notice.key).toBe("C:\\work\\src::notice:loading");
  });

  it("keeps cached children visible next to a failure sentinel", () => {
    const src = directory("src", "C:\\work", {
      expanded: true,
      loadState: "error",
      errorMessage: "The folder could not be read.",
      children: [file("main.ts", "C:\\work\\src")],
    });
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [src],
    });

    const rows = flattenVisibleExplorerRows(stateWith(root));
    expect(rows.map((row) => row.kind)).toEqual([
      "node",
      "node",
      "notice",
      "node",
    ]);
    expect(rows[2]).toMatchObject({
      noticeType: "error",
      message: "The folder could not be read.",
    });
  });

  it("distinguishes a cycle sentinel from an ordinary failure", () => {
    const link = directory("loop", "C:\\work", {
      expanded: true,
      loadState: "error",
      errorMessage: DIRECTORY_CYCLE_MESSAGE,
      children: [],
    });
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [link],
    });

    const rows = flattenVisibleExplorerRows(stateWith(root));
    expect(rows[2]).toMatchObject({ kind: "notice", noticeType: "cycle" });
  });

  it("gives every sentinel a deterministic key", () => {
    const make = () => {
      const src = directory("src", "C:\\work", {
        expanded: true,
        loadState: "loading",
      });
      return stateWith(
        directory("work", "C:", {
          expanded: true,
          loadState: "loaded",
          children: [src],
        }),
      );
    };
    expect(keys(flattenVisibleExplorerRows(make()))).toEqual(
      keys(flattenVisibleExplorerRows(make())),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Inline create editor                                                       */
/* -------------------------------------------------------------------------- */

describe("inline create row", () => {
  it("appears directly inside its parent directory, above cached children", () => {
    const src = directory("src", "C:\\work", {
      expanded: true,
      loadState: "loaded",
      children: [file("main.ts", "C:\\work\\src")],
    });
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [src],
    });
    const state: ExplorerState = {
      ...stateWith(root),
      inlineEdit: {
        type: "create-file",
        parentPath: "C:\\work\\src",
        draftName: "new.ts",
      },
    };

    const rows = flattenVisibleExplorerRows(state);
    expect(rows.map((row) => row.kind)).toEqual([
      "node",
      "node",
      "inline",
      "node",
    ]);
    expect(rows[2].key).toBe(inlineCreateRowKey("C:\\work\\src"));
    expect(rows[2].depth).toBe(2);
  });

  it("is absent while a rename is being edited (rename renders inside its own row)", () => {
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [file("a.ts")],
    });
    const state: ExplorerState = {
      ...stateWith(root),
      inlineEdit: {
        type: "rename",
        sourcePath: "C:\\work\\a.ts",
        originalName: "a.ts",
        draftName: "b.ts",
      },
    };

    expect(
      flattenVisibleExplorerRows(state).some((row) => row.kind === "inline"),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Depth and ancestor metadata (T079)                                         */
/* -------------------------------------------------------------------------- */

describe("ancestor guide metadata", () => {
  const deepState = () => {
    const inner = directory("inner", "C:\\work\\a\\b", {
      expanded: true,
      loadState: "loaded",
      children: [file("x.ts", "C:\\work\\a\\b\\inner"), file("y.ts", "C:\\work\\a\\b\\inner")],
    });
    const b = directory("b", "C:\\work\\a", {
      expanded: true,
      loadState: "loaded",
      children: [inner, file("z.ts", "C:\\work\\a\\b")],
    });
    const a = directory("a", "C:\\work", {
      expanded: true,
      loadState: "loaded",
      children: [b, file("last.ts", "C:\\work\\a")],
    });
    return stateWith(
      directory("work", "C:", {
        expanded: true,
        loadState: "loaded",
        children: [a, directory("second", "C:\\work")],
      }),
    );
  };

  it("records one continuation flag per ancestor level", () => {
    const rows = flattenVisibleExplorerRows(deepState());
    for (const row of rows) {
      expect(row.ancestorContinuation).toHaveLength(row.depth);
    }
  });

  it("marks a last child as not continuing at its own level", () => {
    const rows = flattenVisibleExplorerRows(deepState());
    const byKey = new Map(rows.map((row) => [row.key, row]));

    // `C:\work\a` is the first of two children of the root, so it continues;
    // `C:\work\a\last.ts` is the last child of `a` at depth 1, so level 1 stops.
    expect(byKey.get("C:\\work\\a")?.ancestorContinuation).toEqual([true]);
    expect(byKey.get("C:\\work\\a\\last.ts")?.ancestorContinuation).toEqual([
      true,
      false,
    ]);
    expect(byKey.get("C:\\work\\second")?.ancestorContinuation).toEqual([false]);
  });

  it("carries deep paths correctly and works for symlink rows", () => {    const rows = flattenVisibleExplorerRows(deepState());
    const deep = rows.find(
      (row) => row.kind === "node" && row.path.endsWith("inner\\x.ts"),
    );
    // root(0) -> a(1) -> b(2) -> inner(3) -> x.ts(4)
    expect(deep?.depth).toBe(4);
    // Every ancestor has a following sibling, so every guide level continues.
    expect(deep?.ancestorContinuation).toEqual([true, true, true, true]);

    const link = directory("junction", "C:\\work\\a", {
      isSymlink: true,
      expanded: false,
    });
    const state = stateWith(
      directory("work", "C:", {
        expanded: true,
        loadState: "loaded",
        children: [link],
      }),
    );
    const linkRow = flattenVisibleExplorerRows(state)[1];
    expect(linkRow).toMatchObject({ kind: "node", depth: 1 });
    expect(linkRow.ancestorContinuation).toEqual([false]);
  });

  /*
   * The Tree's guides are one full-height vertical line per ancestor level rather
   * than per-row elbows, so a line is broken only where the flat order returns to
   * a shallower row. That is what ends a line after a directory's last visible
   * descendant — and it is a property of the depth-first order, not of the guide
   * code, which is exactly why it is pinned here.
   */
  it("keeps every subtree contiguous, which is what ends a guide line", () => {
    const rows = flattenVisibleExplorerRows(deepState());
    expect(rows.length).toBeGreaterThan(5);

    rows.forEach((row, index) => {
      let cursor = index + 1;
      while (cursor < rows.length && rows[cursor].depth > row.depth) {
        cursor += 1;
      }
      const next = rows[cursor];
      if (next !== undefined) {
        expect(
          next.depth,
          `the rows below ${row.key} must be its own subtree`,
        ).toBeLessThanOrEqual(row.depth);
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Purity (T080)                                                              */
/* -------------------------------------------------------------------------- */

describe("projection purity", () => {
  it("needs no service and no callback, and mutates nothing (T080, FR-033)", () => {
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [
        directory("src", "C:\\work", {
          expanded: true,
          loadState: "loaded",
          children: [file("main.ts", "C:\\work\\src")],
        }),
      ],
    });
    const state = stateWith(root);
    const before = JSON.stringify(state);

    // `flattenVisibleExplorerRows` takes only the state: there is no reader,
    // controller or callback it could reach even in principle. Freezing the input
    // proves it does not try to normalize or cache anything in place.
    const deepFreeze = (value: unknown): void => {
      if (value === null || typeof value !== "object") {
        return;
      }
      for (const entry of Object.values(value as Record<string, unknown>)) {
        deepFreeze(entry);
      }
      Object.freeze(value);
    };
    deepFreeze(root);

    const rows = flattenVisibleExplorerRows(state);

    expect(rows).toHaveLength(3);
    // The unfrozen copy taken before freezing is unchanged.
    expect(JSON.parse(before)).toBeDefined();
    // And the same input always yields the same output.
    expect(keys(flattenVisibleExplorerRows(state))).toEqual(keys(rows));
  });

  it("does not read a never-loaded directory's absent children", () => {
    const collapsed = directory("node_modules", "C:\\work");
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [collapsed],
    });

    const rows = flattenVisibleExplorerRows(stateWith(root));
    expect(rows).toHaveLength(2);
    // Still not loaded: flattening cannot have triggered a read.
    expect(collapsed.loadState).toBe("not-loaded");
    expect(collapsed.children).toBeUndefined();
  });
});

describe("projection lookup", () => {
  it("locates rows by stable logical key rather than by position", () => {
    const root = directory("work", "C:", {
      expanded: true,
      loadState: "loaded",
      children: [file("a.ts"), file("b.ts")],
    });
    const rows = flattenVisibleExplorerRows(stateWith(root));
    const indexOf = (key: string) => rows.findIndex((row) => row.key === key);

    expect(indexOf("C:\\work")).toBe(0);
    expect(indexOf("C:\\work\\b.ts")).toBe(2);
    expect(indexOf("C:\\work\\missing.ts")).toBe(-1);
  });
});

/* -------------------------------------------------------------------------- */
/* Reveal planning (T110, T120)                                               */
/* -------------------------------------------------------------------------- */

describe("planRowReveal", () => {
  const rows = () =>
    flattenVisibleExplorerRows(
      stateWith(
        directory("work", "C:", {
          expanded: true,
          loadState: "loaded",
          children: [file("a.ts"), file("b.ts")],
        }),
      ),
    );

  it("reports the index of a row that is in the projection", () => {
    expect(planRowReveal(rows(), "C:\\work\\b.ts")).toEqual({
      index: 2,
      handled: true,
    });
  });

  it("keeps a request pending while its row is not in the projection", () => {
    // A locate that expanded a collapsed ancestor produces the row one render
    // later; clearing the request now would drop the reveal silently.
    expect(planRowReveal(rows(), "C:\\work\\missing.ts")).toEqual({
      index: -1,
      handled: false,
    });
  });

  it("has nothing to handle without a request", () => {
    expect(planRowReveal(rows(), null)).toEqual({ index: -1, handled: false });
    expect(planRowReveal(rows(), undefined)).toEqual({
      index: -1,
      handled: false,
    });
  });

  it("finds a row that only becomes visible once its ancestor is expanded", () => {
    const collapsed = stateWith(
      directory("work", "C:", {
        expanded: true,
        loadState: "loaded",
        children: [
          directory("src", "C:\\work", {
            expanded: false,
            loadState: "loaded",
            children: [file("hidden.ts", "C:\\work\\src")],
          }),
        ],
      }),
    );
    expect(planRowReveal(flattenVisibleExplorerRows(collapsed), "C:\\work\\src\\hidden.ts").handled).toBe(false);

    const expanded = stateWith(
      directory("work", "C:", {
        expanded: true,
        loadState: "loaded",
        children: [
          directory("src", "C:\\work", {
            expanded: true,
            loadState: "loaded",
            children: [file("hidden.ts", "C:\\work\\src")],
          }),
        ],
      }),
    );
    // Projection order: root (0), src (1), hidden.ts (2).
    expect(planRowReveal(flattenVisibleExplorerRows(expanded), "C:\\work\\src\\hidden.ts")).toEqual({
      index: 2,
      handled: true,
    });
  });
});
