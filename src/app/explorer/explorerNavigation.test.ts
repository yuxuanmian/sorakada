/**
 * T113/T116/T117/T124: Collapse All, Locate Current File and Header availability.
 *
 * The Explorer may only read what it already represents, one level at a time.
 * These tests run against a **recording** reader, so "Locate read exactly the
 * ancestor chain and no sibling branch" and "type-to-search read nothing" are
 * measured rather than asserted in prose (SC-002, SC-003, T125).
 */

import { describe, expect, it } from "vitest";

import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import { displayNameForWorkspaceRoot } from "../workspace/workContext";
import type { WorkContext } from "../workspace/workContext";
import { ExplorerController } from "./explorerController";
import {
  explorerHeaderActions,
  isLocateAvailable,
  isMoreAvailable,
  buildExplorerMoreMenuModel,
  type ExplorerHeaderState,
} from "./explorerHeaderActions";
import { locateCurrentFile, locateRelativeChain, type LocateRequest } from "./explorerLocate";
import { flattenVisibleExplorerRows } from "./explorerProjection";
import { matchVisibleRowKeys } from "./explorerQuickSearch";
import { deriveFileOperationContext } from "./explorerActions";
import { allMenuItems } from "../../ui/menu/menuModel";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ROOT = "C:\\work";

/** A Workspace shaped like a real project: one deep chain plus sibling branches. */
function createTree(): Record<string, string[]> {
  return {
    "c:\\work": ["a", "sibling-1", "sibling-2"],
    "c:\\work\\a": ["b", "a-sibling"],
    "c:\\work\\a\\b": ["deep.ts", "b-sibling"],
    "c:\\work\\a\\b\\b-sibling": [],
    "c:\\work\\a\\a-sibling": [],
    "c:\\work\\sibling-1": [],
    "c:\\work\\sibling-2": [],
  };
}

class RecordingReader {
  readonly reads: string[] = [];

  /** One fixture per reader, so a test can add a file without leaking it. */
  constructor(private readonly tree: Record<string, string[]> = createTree()) {}

  /** Makes a file appear in `parentPath` after the directory was already read. */
  addFile(parentPath: string, name: string): void {
    const key = parentPath.toLowerCase();
    this.tree[key] = [...(this.tree[key] ?? []), name];
  }

  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult> {
    this.reads.push(path);
    const names = this.tree[path.toLowerCase()] ?? [];
    const entries: WorkspaceDirectoryEntry[] = names.map((name) => {
      const lower = name.toLowerCase();
      const isDirectory = Object.keys(this.tree).includes(
        `${path.toLowerCase()}\\${lower}`,
      );
      return {
        name,
        path: `${path}\\${name}`,
        kind: isDirectory ? "directory" : "file",
        isSymlink: false,
        objectIdentity: `fake:${path.toLowerCase()}\\${lower}`,
      };
    });
    return Promise.resolve({
      requestedPath: path,
      canonicalPath: path,
      comparisonKey: path.toLowerCase(),
      caseSensitive: false,
      entries,
    });
  }

  clear(): void {
    this.reads.length = 0;
  }

  readCount(): number {
    return this.reads.length;
  }

  readsFor(path: string): number {
    return this.reads.filter((read) => read.toLowerCase() === path.toLowerCase())
      .length;
  }
}

function context(): WorkContext {
  return {
    id: "workspace-1",
    rootPath: ROOT,
    canonicalRootPath: ROOT,
    comparisonKey: ROOT.toLowerCase(),
    displayName: displayNameForWorkspaceRoot(ROOT),
  };
}

async function openTree() {
  const reader = new RecordingReader();
  const controller = new ExplorerController({ workspaceFileService: reader });
  controller.setContext(context());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { controller, reader };
}

function request(path: string): LocateRequest {
  return {
    documentId: "doc-1",
    path,
    pathKey: path.toLowerCase(),
    contextId: "workspace-1",
  };
}

const current = () => true;

/* -------------------------------------------------------------------------- */
/* Locate Current File                                                        */
/* -------------------------------------------------------------------------- */

describe("locateCurrentFile", () => {
  it("rejects an untitled or non-disk document before doing anything", async () => {
    const { controller, reader } = await openTree();
    reader.clear();

    // The availability predicate refuses it first; the coordinator also refuses a
    // request whose path cannot be inside the Workspace.
    const state = currentState();
    expect(
      isLocateAvailable({
        ...state,
        activeDocumentPathKey: null,
      }),
    ).toBe(false);

    const outcome = await locateCurrentFile(
      { documentId: "doc-1", path: "C:\\elsewhere\\a.txt", pathKey: "c:\\elsewhere\\a.txt", contextId: "workspace-1" },
      { tree: controller, isCurrent: current },
    );
    expect(outcome).toEqual({ status: "rejected", reason: "outside-workspace" });
    expect(reader.readCount()).toBe(0);
  });

  it("rejects a sibling branch that only shares a name prefix (T118)", async () => {
    const { controller, reader } = await openTree();
    reader.clear();

    const outcome = await locateCurrentFile(
      request("C:\\work-old\\a.txt"),
      { tree: controller, isCurrent: current },
    );

    expect(outcome).toEqual({ status: "rejected", reason: "outside-workspace" });
    expect(reader.reads).toEqual([]);
  });

  it("reads exactly the ancestor chain of a depth-N file (T117, SC-003)", async () => {
    const { controller, reader } = await openTree();
    reader.clear();

    const outcome = await locateCurrentFile(
      request("C:\\work\\a\\b\\deep.ts"),
      { tree: controller, isCurrent: current },
    );

    expect(outcome).toEqual({ status: "located", path: "C:\\work\\a\\b\\deep.ts" });
    // Only the two directories on the chain are read: the root was already
    // materialized, and no sibling branch is ever touched.
    expect(reader.reads).toEqual(["C:\\work\\a", "C:\\work\\a\\b"]);
    expect(controller.getSelectedPath()).toBe("C:\\work\\a\\b\\deep.ts");
  });

  /**
   * The reported defect: locating a file whose ancestor chain is *read* but
   * collapsed. The walk used to succeed from the cache and return `located`, while
   * the visible-row projection (which only descends through expanded directories)
   * still had no row to reveal — so the locate looked like a no-op.
   */
  it("reveals a file whose ancestors are loaded but collapsed", async () => {
    const { controller, reader } = await openTree();

    // The user visited the branch once and then collapsed it: the children are
    // cached while the rows are off screen.
    await controller.expandDirectory("C:\\work\\a");
    await controller.expandDirectory("C:\\work\\a\\b");
    await controller.toggleDirectory("C:\\work\\a");
    expect(controller.getNode("C:\\work\\a")).toMatchObject({ expanded: false });
    expect(controller.getNode("C:\\work\\a\\b")).toMatchObject({
      expanded: true,
    });

    const visibleBefore = flattenVisibleExplorerRows(controller.getState()).map(
      (row) => row.key,
    );
    expect(visibleBefore).not.toContain("C:\\work\\a\\b\\deep.ts");
    reader.clear();

    const outcome = await locateCurrentFile(
      request("C:\\work\\a\\b\\deep.ts"),
      { tree: controller, isCurrent: current },
    );

    expect(outcome).toEqual({
      status: "located",
      path: "C:\\work\\a\\b\\deep.ts",
    });

    // The whole ancestor chain is expanded, which is what the projection needs.
    expect(controller.getNode("C:\\work\\a")).toMatchObject({ expanded: true });
    expect(controller.getNode("C:\\work\\a\\b")).toMatchObject({ expanded: true });

    // The point of the fix: the target row really exists in the projection, so the
    // virtual Tree can scroll to it.
    expect(
      flattenVisibleExplorerRows(controller.getState()).map((row) => row.key),
    ).toContain("C:\\work\\a\\b\\deep.ts");
    expect(controller.getSelectedPath()).toBe("C:\\work\\a\\b\\deep.ts");

    // Still bounded to the chain: only those directories may be read, and the
    // sibling branches stay untouched (SC-003).
    expect(
      reader.reads.every(
        (read) => read === "C:\\work\\a" || read === "C:\\work\\a\\b",
      ),
    ).toBe(true);
    expect(reader.readsFor("C:\\work\\sibling-1")).toBe(0);
    expect(reader.readsFor("C:\\work\\a\\a-sibling")).toBe(0);
    expect(reader.readsFor("C:\\work\\a\\b\\b-sibling")).toBe(0);
  });

  it("reveals a file when the represented root itself was collapsed", async () => {
    const { controller } = await openTree();
    await controller.toggleDirectory(ROOT);
    expect(controller.getNode(ROOT)).toMatchObject({ expanded: false });

    const outcome = await locateCurrentFile(request("C:\\work\\a"), {
      tree: controller,
      isCurrent: current,
    });

    expect(outcome).toEqual({ status: "located", path: "C:\\work\\a" });
    expect(controller.getNode(ROOT)).toMatchObject({ expanded: true });
    expect(
      flattenVisibleExplorerRows(controller.getState()).map((row) => row.key),
    ).toContain("C:\\work\\a");
  });

  it("expands a collapsed intermediate ancestor while keeping cached siblings", async () => {
    const { controller } = await openTree();
    await controller.expandDirectory("C:\\work\\a");
    await controller.toggleDirectory("C:\\work\\a");

    await locateCurrentFile(request("C:\\work\\a\\b\\deep.ts"), {
      tree: controller,
      isCurrent: current,
    });

    // The cached sibling that was materialized before the collapse is still there,
    // so re-expansion is immediate rather than a fresh tree.
    expect(controller.getNode("C:\\work\\a\\a-sibling")).not.toBeNull();
    expect(controller.getNode("C:\\work\\a\\b\\deep.ts")).not.toBeNull();
  });

  it("waits for an in-flight read instead of giving up on a still-loading level", async () => {
    const reader = new RecordingReader();
    const controller = new ExplorerController({ workspaceFileService: reader });
    // The Workspace was just opened: the root's read has been issued but has not
    // settled, so the root has no children yet.
    controller.setContext(context());
    expect(controller.getNode(ROOT)).toMatchObject({ loadState: "loading" });

    const outcome = await locateCurrentFile(request("C:\\work\\a"), {
      tree: controller,
      isCurrent: current,
    });

    expect(outcome).toEqual({ status: "located", path: "C:\\work\\a" });
    expect(controller.getSelectedPath()).toBe("C:\\work\\a");
    expect(
      flattenVisibleExplorerRows(controller.getState()).map((row) => row.key),
    ).toContain("C:\\work\\a");
  });

  it("re-reads the target's own parent once when the file appeared after that read", async () => {
    const { controller, reader } = await openTree();
    // The parent is read and expanded while the file does not exist yet.
    await controller.expandDirectory("C:\\work\\a");
    await controller.expandDirectory("C:\\work\\a\\b");
    reader.clear();

    // A build step creates the file; the watcher has not converged yet.
    reader.addFile("C:\\work\\a\\b", "late.ts");

    const outcome = await locateCurrentFile(
      request("C:\\work\\a\\b\\late.ts"),
      { tree: controller, isCurrent: current },
    );

    expect(outcome).toEqual({ status: "located", path: "C:\\work\\a\\b\\late.ts" });
    // Exactly one bounded re-read of the file's own directory — never a search.
    expect(reader.reads).toEqual(["C:\\work\\a\\b"]);
  });

  it("selects the target and leaves expansion consistent", async () => {
    const { controller } = await openTree();

    await locateCurrentFile(request("C:\\work\\a\\b\\deep.ts"), {
      tree: controller,
      isCurrent: current,
    });

    expect(controller.getNode("C:\\work\\a")).toMatchObject({ expanded: true });
    expect(controller.getNode("C:\\work\\a\\b")).toMatchObject({ expanded: true });
    expect(controller.getSelectedNode()?.path).toBe("C:\\work\\a\\b\\deep.ts");
  });

  it("fails safely on a missing component without searching for it", async () => {
    const { controller, reader } = await openTree();
    reader.clear();

    const outcome = await locateCurrentFile(
      request("C:\\work\\a\\b\\does-not-exist.ts"),
      { tree: controller, isCurrent: current },
    );

    expect(outcome).toEqual({ status: "rejected", reason: "missing-component" });
    // The chain was read one level at a time, and the file's own directory was
    // re-read exactly once because it was already loaded and the file was not in
    // its cache. Nothing beyond the chain is ever read (FR-052, SC-003).
    expect(reader.reads).toEqual([
      "C:\\work\\a",
      "C:\\work\\a\\b",
      "C:\\work\\a\\b",
    ]);
    for (const sibling of [
      "C:\\work\\sibling-1",
      "C:\\work\\sibling-2",
      "C:\\work\\a\\a-sibling",
      "C:\\work\\a\\b\\b-sibling",
    ]) {
      expect(reader.readsFor(sibling), sibling).toBe(0);
    }
    expect(controller.getSelectedPath()).toBeNull();
  });

  it("discards a stale intent when the Workspace was replaced (T116)", async () => {
    const { controller } = await openTree();

    const outcome = await locateCurrentFile(request("C:\\work\\a\\b\\deep.ts"), {
      tree: controller,
      isCurrent: () => false,
    });

    expect(outcome).toEqual({ status: "rejected", reason: "stale" });
    expect(controller.getSelectedPath()).toBeNull();
  });

  it("discards a stale intent when the active document was rebound (T116)", async () => {
    const { controller } = await openTree();

    // The document was switched before the reveal settled.
    const outcome = await locateCurrentFile(request("C:\\work\\a\\b\\deep.ts"), {
      tree: controller,
      isCurrent: (candidate) => candidate.path.endsWith("other.ts"),
    });

    expect(outcome.status).toBe("rejected");
    expect(controller.getSelectedPath()).toBeNull();
  });

  it("refuses without a Workspace instead of guessing", async () => {
    const { controller, reader } = await openTree();
    controller.setContext(null);
    reader.clear();

    const outcome = await locateCurrentFile(request("C:\\work\\a.ts"), {
      tree: controller,
      isCurrent: current,
    });

    expect(outcome).toEqual({ status: "rejected", reason: "no-workspace" });
    expect(reader.reads).toEqual([]);
  });

  it("builds the relative chain from canonical components", () => {
    const chain = locateRelativeChain(context(), request("C:\\work\\a\\b\\deep.ts"));
    expect(chain?.components).toEqual(["a", "b", "deep.ts"]);
    expect(
      locateRelativeChain(context(), request("C:\\work-old\\deep.ts")),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Collapse All (T113)                                                        */
/* -------------------------------------------------------------------------- */

describe("ExplorerController.collapseAll", () => {
  async function deepTree() {
    const { controller, reader } = await openTree();
    await controller.expandDirectory("C:\\work\\a");
    await controller.expandDirectory("C:\\work\\a\\b");
    controller.selectPath("C:\\work\\a\\b\\deep.ts");
    return { controller, reader };
  }

  it("collapses nested expansion while keeping the root anchor expanded", async () => {
    const { controller } = await deepTree();
    expect(controller.getNode("C:\\work\\a")).toMatchObject({ expanded: true });

    expect(controller.collapseAll()).toBe(true);

    expect(controller.getState().root).toMatchObject({ expanded: true });
    expect(controller.getNode("C:\\work\\a")).toMatchObject({ expanded: false });
    expect(controller.getNode("C:\\work\\a\\b")).toMatchObject({
      expanded: false,
    });
  });

  it("keeps cached child data so re-expansion is immediate and free", async () => {
    const { controller, reader } = await deepTree();
    controller.collapseAll();
    reader.clear();

    await controller.expandDirectory("C:\\work\\a");

    // The cached children are still there, and a loaded directory's re-expansion
    // only requests a bounded reconciliation.
    expect(controller.getNode("C:\\work\\a\\b")).not.toBeNull();
    expect(controller.getNode("C:\\work\\a\\b\\deep.ts")).not.toBeNull();
    expect(reader.readCount()).toBeLessThanOrEqual(1);
  });

  it("does not touch selection, so a hidden descendant stays logically selected", async () => {
    const { controller } = await deepTree();
    controller.collapseAll();

    expect(controller.getSelectedPath()).toBe("C:\\work\\a\\b\\deep.ts");
    // ...but it is not forced visible.
    const visible = flattenVisibleExplorerRows(controller.getState()).map(
      (row) => row.key,
    );
    expect(visible).not.toContain("C:\\work\\a\\b\\deep.ts");
    expect(visible).toContain("C:\\work\\a");
  });

  it("cancels an inline editor whose row the collapse hid", async () => {
    const { controller } = await deepTree();
    controller.beginRename("C:\\work\\a\\b\\deep.ts");

    controller.collapseAll();

    expect(controller.getInlineEdit()).toBeNull();
  });

  it("reports whether anything was collapsed", async () => {
    const { controller } = await openTree();
    expect(controller.hasExpandedDescendants()).toBe(false);
    expect(controller.collapseAll()).toBe(false);

    await controller.expandDirectory("C:\\work\\a");
    expect(controller.hasExpandedDescendants()).toBe(true);
    expect(controller.collapseAll()).toBe(true);
    expect(controller.collapseAll()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Header availability (T124)                                                 */
/* -------------------------------------------------------------------------- */

function currentState(): ExplorerHeaderState {
  return {
    hasWorkspace: true,
    hasExpandedDirectories: true,
    activeDocumentPathKey: "c:\\work\\a\\b\\deep.ts",
    workspaceComparisonKey: "c:\\work",
  };
}

describe("Explorer Header availability", () => {
  it("disables Locate without a Workspace", () => {
    expect(
      isLocateAvailable({
        ...currentState(),
        hasWorkspace: false,
        workspaceComparisonKey: null,
      }),
    ).toBe(false);
  });

  it("disables Locate without an active disk-backed document", () => {
    expect(
      isLocateAvailable({ ...currentState(), activeDocumentPathKey: null }),
    ).toBe(false);
  });

  it("disables Locate for a document outside the Workspace", () => {
    expect(
      isLocateAvailable({
        ...currentState(),
        activeDocumentPathKey: "c:\\elsewhere\\a.ts",
      }),
    ).toBe(false);
    expect(
      isLocateAvailable({
        ...currentState(),
        activeDocumentPathKey: "c:\\work-old\\a.ts",
      }),
    ).toBe(false);
  });

  it("enables Locate for an inside file, regardless of DOM focus", () => {
    const actions = explorerHeaderActions(currentState());
    const locate = actions.find(
      (action) => action.commandId === "explorer.locateCurrentFile",
    );
    expect(locate?.enabled).toBe(true);
  });

  it("disables Collapse All when nothing is expanded", () => {
    const actions = explorerHeaderActions({
      ...currentState(),
      hasExpandedDirectories: false,
    });
    expect(
      actions.find((action) => action.commandId === "explorer.collapseAll")
        ?.enabled,
    ).toBe(false);
  });

  it("shows More whenever a Workspace is open", () => {
    expect(isMoreAvailable(currentState())).toBe(true);
    expect(isMoreAvailable({ ...currentState(), hasWorkspace: false })).toBe(
      false,
    );
  });
});

describe("Explorer More popup (T121, T122)", () => {
  const workspace = context();

  it("offers creation and Refresh for the root context", () => {
    const model = buildExplorerMoreMenuModel(
      deriveFileOperationContext(workspace, null),
      { isEnabled: () => true },
    );
    expect(allMenuItems(model).map((item) => item.commandId)).toEqual([
      "explorer.newFile",
      "explorer.newFolder",
      "explorer.refresh",
    ]);
  });

  it("keeps Refresh reachable for a file context without creation", () => {
    const file = {
      name: "a.ts",
      path: "C:\\work\\a.ts",
      kind: "file" as const,
      isSymlink: false,
      objectIdentity: null,
    };
    const model = buildExplorerMoreMenuModel(
      deriveFileOperationContext(workspace, file),
      { isEnabled: () => true },
    );
    // 003's shared target rule still allows creation beside a selected file, so
    // More keeps it discoverable (FR-030).
    expect(allMenuItems(model).map((item) => item.commandId)).toEqual([
      "explorer.newFile",
      "explorer.newFolder",
      "explorer.refresh",
    ]);
  });

  it("marks entries the registry refuses as disabled", () => {
    const model = buildExplorerMoreMenuModel(
      deriveFileOperationContext(workspace, null),
      { isEnabled: (id) => id !== "explorer.refresh" },
    );
    const refresh = allMenuItems(model).find(
      (item) => item.commandId === "explorer.refresh",
    );
    expect(refresh?.disabled).toBe(true);
  });

  it("offers nothing without a Workspace", () => {
    const model = buildExplorerMoreMenuModel(
      deriveFileOperationContext(null, null),
      { isEnabled: () => true },
    );
    expect(allMenuItems(model)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* No recursive I/O (T125, SC-002)                                            */
/* -------------------------------------------------------------------------- */

describe("type-to-search performs zero directory reads (SC-002)", () => {
  it("matches only what is already materialized", async () => {
    const { controller, reader } = await openTree();
    await controller.expandDirectory("C:\\work\\a");
    const rows = flattenVisibleExplorerRows(controller.getState());
    reader.clear();

    const matches = matchVisibleRowKeys(rows, "b");
    expect(matches).toContain("C:\\work\\a\\b");
    // Nothing under the collapsed branches was read, expanded or inspected.
    expect(reader.readCount()).toBe(0);
    expect(controller.getNode("C:\\work\\sibling-1")).toMatchObject({
      expanded: false,
      loadState: "not-loaded",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */
