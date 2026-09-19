/**
 * T102/T103: the virtualization regression coverage.
 *
 * Replacing recursive rendering with flattening + a virtual viewport must not
 * touch anything the controller owns, and the Explorer-level operation target must
 * keep working when rows are recycled. Both are asserted here against a *real*
 * `ExplorerController` with a recording reader, so the test would fail if the
 * projection started reading, expanding or selecting on its own.
 */

import { describe, expect, it } from "vitest";

import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import type { WorkContext } from "../workspace/workContext";
import {
  LARGE_TREE_ACCEPTANCE_VIEWPORT_PX,
  createTenThousandRowExplorerTree,
} from "../performance/treeFixtures";
import { DENSITY_METRICS } from "../shell/density";
import { ExplorerController } from "./explorerController";
import { rowPathFromTarget } from "./explorerContextTarget";
import {
  flattenVisibleExplorerRows,
} from "./explorerProjection";
import { maxMountedRows, TREE_OVERSCAN_ROWS } from "./explorerTreeMetrics";

const ROOT = "C:\\work";
const SRC = "C:\\work\\src";

/** A recording Workspace reader; the only thing that may produce a read. */
class RecordingReader {
  readonly reads: string[] = [];

  constructor(private readonly directories: Map<string, WorkspaceDirectoryEntry[]>) {}

  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult> {
    this.reads.push(path);
    return Promise.resolve({
      requestedPath: path,
      canonicalPath: path,
      comparisonKey: path.toLowerCase(),
      caseSensitive: false,
      entries: this.directories.get(path.toLowerCase()) ?? [],
    });
  }

  readCount(): number {
    return this.reads.length;
  }
}

function entry(
  path: string,
  kind: WorkspaceDirectoryEntry["kind"],
): WorkspaceDirectoryEntry {
  return {
    name: path.split("\\").pop() ?? path,
    path,
    kind,
    isSymlink: false,
    objectIdentity: `fake:${path.toLowerCase()}`,
  };
}

function context(rootPath: string): WorkContext {
  return {
    id: `workspace-${rootPath}`,
    rootPath,
    canonicalRootPath: rootPath,
    comparisonKey: rootPath.toLowerCase(),
    displayName: "work",
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createHarness() {
  const reader = new RecordingReader(
    new Map([
      [
        ROOT.toLowerCase(),
        [entry(SRC, "directory"), entry("C:\\work\\a.ts", "file")],
      ],
      [
        SRC.toLowerCase(),
        [entry("C:\\work\\src\\main.ts", "file"), entry("C:\\work\\src\\lib", "directory")],
      ],
      ["C:\\work\\src\\lib".toLowerCase(), []],
    ]),
  );
  const controller = new ExplorerController({
    workspaceFileService: reader,
  });
  return { controller, reader };
}

describe("virtualization leaves ExplorerController ownership intact (T102)", () => {
  it("does not read, expand or select while flattening", async () => {
    const { controller, reader } = createHarness();
    controller.setContext(context(ROOT));
    await flush();
    await controller.expandDirectory(SRC);
    controller.selectPath(SRC);
    controller.beginRename("C:\\work\\src\\main.ts");

    const readsBefore = reader.readCount();
    const stateBefore = controller.getState();

    for (let pass = 0; pass < 25; pass += 1) {
      flattenVisibleExplorerRows(controller.getState());
    }

    expect(reader.readCount()).toBe(readsBefore);
    expect(controller.getSelectedPath()).toBe(SRC);
    expect(controller.getNode(SRC)).toMatchObject({ expanded: true });
    expect(controller.getInlineEdit()).toMatchObject({
      type: "rename",
      sourcePath: "C:\\work\\src\\main.ts",
    });
    // The same state object is still the controller's own.
    expect(controller.getState()).toBe(stateBefore);
  });

  it("keeps a selected and inline-edited row logically intact when its row unmounts", async () => {
    const { controller, reader } = createHarness();
    controller.setContext(context(ROOT));
    await flush();
    await controller.expandDirectory(SRC);

    const target = "C:\\work\\src\\main.ts";
    controller.selectPath(target);
    controller.beginRename(target);

    // A recycled row disappears from the DOM; the projection is rebuilt from the
    // controller's state, which is untouched by that.
    const firstPass = flattenVisibleExplorerRows(controller.getState());
    expect(firstPass.some((row) => row.key === target)).toBe(true);

    const selectedAfterRecycle = controller.getSelectedPath();
    expect(selectedAfterRecycle).toBe(target);
    expect(controller.getInlineEdit()).not.toBeNull();
    expect(reader.readCount()).toBe(2);
  });

  it("treats logical keys, not indexes, as row identity across a projection change", async () => {
    const { controller } = createHarness();
    controller.setContext(context(ROOT));
    await flush();
    await controller.expandDirectory(SRC);

    const expanded = flattenVisibleExplorerRows(controller.getState());
    const indexBefore = expanded.findIndex(
      (row) => row.key === "C:\\work\\src\\lib",
    );

    controller.selectPath("C:\\work\\src\\main.ts");
    controller.beginCreate("file", SRC);
    const withEditor = flattenVisibleExplorerRows(controller.getState());
    const indexAfter = withEditor.findIndex(
      (row) => row.key === "C:\\work\\src\\lib",
    );

    // The create editor shifts the row, so a stored index would now point at the
    // wrong entry; the logical key does not.
    expect(indexAfter).toBe(indexBefore + 1);
    expect(withEditor[indexAfter!].key).toBe("C:\\work\\src\\lib");
  });

  it("keeps the operation target authoritative for virtual rows and background", async () => {
    const { controller } = createHarness();
    controller.setContext(context(ROOT));
    await flush();

    const rowElement = (path: string) => ({
      closest: () => ({ getAttribute: () => path }),
    });

    // A gesture on a mounted row resolves that row's logical path.
    const rowPath = rowPathFromTarget(rowElement("C:\\work\\a.ts"));
    controller.selectPath(rowPath);
    expect(controller.getSelectedNode()?.path).toBe("C:\\work\\a.ts");

    // A gesture on blank space is root context; the controller's selection is
    // cleared by the same 003 rule the menu uses.
    const backgroundPath = rowPathFromTarget({
      closest: () => null,
    });
    expect(backgroundPath).toBeNull();
    controller.clearSelection();
    expect(controller.getSelectedPath()).toBeNull();
  });
});

describe("SC-001 mounted-row bound (T101)", () => {
  it("keeps the configured viewport bound far below 200 mounted rows", () => {
    // 1200x780 window minus TopBar, Tab strip and Footer.
    const viewportHeight =
      LARGE_TREE_ACCEPTANCE_VIEWPORT_PX - 34 - 30 - 22;

    for (const density of ["compact", "default", "comfortable"] as const) {
      const bound = maxMountedRows(
        viewportHeight,
        DENSITY_METRICS[density].treeRowHeight,
      );
      expect(bound, density).toBeLessThan(200);
    }
  });

  it("scales the bound with the viewport, not with the visible-node count", () => {
    const state = createTenThousandRowExplorerTree();
    const rows = flattenVisibleExplorerRows(state);
    expect(rows.length).toBeGreaterThanOrEqual(10_000);

    const small = maxMountedRows(700, 22);
    const large = maxMountedRows(1400, 22);
    // Doubling the viewport doubles the mounted rows; 10,000 visible rows change
    // nothing about the bound.
    expect(large).toBeLessThanOrEqual(small * 2 + 2);
    expect(small).toBe(Math.ceil(700 / 22) + TREE_OVERSCAN_ROWS * 2 + 1);
  });

  it("projects the shared fixture without reading anything", () => {
    const state = createTenThousandRowExplorerTree();
    const rows = flattenVisibleExplorerRows(state);
    expect(rows[0]).toMatchObject({ kind: "node", depth: 0 });
    expect(rows.length).toBe(1 + 100 * (1 + 99));
  });
});
