/**
 * T229: the 10,000-row Explorer fixture is filesystem-free **and** isolated.
 *
 * The fixture is a development harness, but it renders in the same Explorer a real
 * Workspace does. Two things therefore have to hold while it is on screen: the
 * fixture renders without a Workspace of its own, and nothing a user does to it can
 * reach the real controller or a real Explorer action. Both are asserted here
 * against a *real* `ExplorerController` with a recording reader, so the test fails if
 * a fixture path ever becomes controller state, and if any part of the path starts
 * reading the filesystem (FR-089, FR-095, T182).
 */

import { describe, expect, it } from "vitest";

import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import type { WorkContext } from "../workspace/workContext";
import { ExplorerController } from "../explorer/explorerController";
import { flattenVisibleExplorerRows } from "../explorer/explorerProjection";
import { matchVisibleRowKeys, selectableMatchPath } from "../explorer/explorerQuickSearch";
import {
  FIXTURE_WORKSPACE_CONTEXT_ID,
  FIXTURE_WORKSPACE_NAME,
  createTenThousandRowExplorerTree,
  fixtureExplorerProjection,
  isFixtureExplorerState,
  routeExplorerSelection,
} from "./treeFixtures";

const ROOT = "C:\\work";
const SRC = "C:\\work\\src";
const REAL_FILE = "C:\\work\\src\\main.ts";

/** A recording Workspace reader; the only thing that may produce a read. */
class RecordingReader {
  readonly reads: string[] = [];

  constructor(
    private readonly directories: Map<string, WorkspaceDirectoryEntry[]>,
  ) {}

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

/** A real controller over a real (recorded) Workspace, with a selection. */
async function createControllerHarness() {
  const reader = new RecordingReader(
    new Map([
      [ROOT.toLowerCase(), [entry(SRC, "directory"), entry("C:\\work\\a.ts", "file")]],
      [SRC.toLowerCase(), [entry(REAL_FILE, "file")]],
    ]),
  );
  const controller = new ExplorerController({ workspaceFileService: reader });
  controller.setContext(context(ROOT));
  await flush();
  await controller.expandDirectory(SRC);
  controller.selectPath(REAL_FILE);
  return { controller, reader };
}

describe("the Explorer fixture renders without a Workspace (T229)", () => {
  it("is identified by its own context marker, not by a real Workspace id", () => {
    const fixture = createTenThousandRowExplorerTree();

    expect(fixture.contextId).toBe(FIXTURE_WORKSPACE_CONTEXT_ID);
    expect(isFixtureExplorerState(fixture)).toBe(true);
    expect(fixture.contextId).not.toBe(context(ROOT).id);
  });

  it("never mistakes a real projection, or nothing at all, for the fixture", () => {
    // The harness has to be *decidable from the state*, so a real Workspace
    // projection cannot silently make the Tree read-only.
    const real = createTenThousandRowExplorerTree();
    const notTheFixture = { ...real, contextId: context(ROOT).id };

    expect(isFixtureExplorerState(notTheFixture)).toBe(false);
    expect(isFixtureExplorerState(null)).toBe(false);
    expect(isFixtureExplorerState(undefined)).toBe(false);
  });

  it("carries a root and a name of its own, so it renders standalone", () => {
    const fixture = createTenThousandRowExplorerTree();

    // The Explorer shows its no-Workspace state only for a `null` context, so the
    // fixture renders its Tree with no Workspace open at all.
    expect(fixture.root).not.toBeNull();
    expect(fixture.root?.name).toBe(FIXTURE_WORKSPACE_NAME);
    expect(fixture.rootUnavailable).toBe(false);
    expect(flattenVisibleExplorerRows(fixture).length).toBeGreaterThanOrEqual(
      10_000,
    );
  });
});

describe("the Explorer fixture owns its own selection (T229)", () => {
  it("keeps the selection in UI state and leaves the fixture model untouched", () => {
    const fixture = createTenThousandRowExplorerTree();
    const target = flattenVisibleExplorerRows(fixture)[7_000].key;

    const projection = fixtureExplorerProjection(fixture, target);

    expect(projection.selectedPath).toBe(target);
    // Exactly one field differs, and the fixture itself never changes: the harness
    // cannot accumulate state a later real render would inherit.
    expect({ ...projection, selectedPath: null }).toEqual(fixture);
    expect(fixture.selectedPath).toBeNull();
    expect(projection.inlineEdit).toBeNull();
  });

  it("routes every fixture gesture away from the controller", () => {
    const fixture = createTenThousandRowExplorerTree();
    const fixturePath = flattenVisibleExplorerRows(fixture)[9_000].key;

    // A row click, a right-click target and a quick-search match all take this route.
    expect(routeExplorerSelection({ fixture, path: fixturePath })).toEqual({
      owner: "fixture",
      selection: fixturePath,
    });
    // A gesture on blank space clears the fixture's own selection.
    expect(routeExplorerSelection({ fixture, path: null })).toEqual({
      owner: "fixture",
      selection: null,
    });

    // With the fixture off, the same gesture is the controller's, unchanged.
    expect(routeExplorerSelection({ fixture: null, path: REAL_FILE })).toEqual({
      owner: "controller",
      path: REAL_FILE,
    });
    expect(routeExplorerSelection({ fixture: null, path: null })).toBeNull();
  });

  it("never routes one of the fixture's own paths to the controller", () => {
    const fixture = createTenThousandRowExplorerTree();
    const paths = [
      fixture.root!.path,
      ...flattenVisibleExplorerRows(fixture)
        .slice(0, 64)
        .map((row) => row.key),
    ];

    for (const path of paths) {
      const route = routeExplorerSelection({ fixture, path });
      expect(route?.owner, path).toBe("fixture");
    }
  });

  it("selects a quick-search match inside the fixture without touching the real Tree", async () => {
    const { controller, reader } = await createControllerHarness();
    const readsBefore = reader.readCount();
    const selectionBefore = controller.getSelectedPath();

    const fixture = createTenThousandRowExplorerTree();
    const rows = flattenVisibleExplorerRows(
      fixtureExplorerProjection(fixture, null),
    );
    const matchKeys = matchVisibleRowKeys(rows, "file-0001");
    expect(matchKeys.length).toBeGreaterThan(0);

    // The current match is selected exactly as the Explorer does it: through the
    // same routing decision, applied to the rendered projection.
    const currentKey = matchKeys[0];
    const matchPath = selectableMatchPath(rows, currentKey);
    expect(matchPath).toBe(currentKey);

    const route = routeExplorerSelection({ fixture, path: matchPath });
    expect(route).toEqual({ owner: "fixture", selection: currentKey });
    const projection = fixtureExplorerProjection(
      fixture,
      route?.owner === "fixture" ? route.selection : null,
    );
    expect(projection.selectedPath).toBe(currentKey);

    // Nothing was read, and the real selection is exactly what it was (FR-095).
    expect(reader.readCount()).toBe(readsBefore);
    expect(controller.getSelectedPath()).toBe(selectionBefore);
    expect(controller.getSelectedPath()).toBe(REAL_FILE);
  });

  it("keeps the real selection when a fixture path is offered to the controller", async () => {
    const { controller } = await createControllerHarness();
    const fixture = createTenThousandRowExplorerTree();
    const fixturePath = flattenVisibleExplorerRows(fixture)[1].key;

    // The controller genuinely does not contain the fixture's entries: asking it
    // would only produce a silently wrong selection, which is why the route never
    // sends one there.
    expect(controller.getNode(fixturePath)).toBeNull();
    expect(routeExplorerSelection({ fixture, path: fixturePath })?.owner).toBe(
      "fixture",
    );
    expect(controller.getSelectedPath()).toBe(REAL_FILE);
  });

  it("projects the shared fixture without reading anything (FR-089, FR-095)", async () => {
    const { reader } = await createControllerHarness();
    reader.reads.length = 0;

    const fixture = createTenThousandRowExplorerTree();
    for (const selection of [null, fixture.root!.path]) {
      const projection = fixtureExplorerProjection(fixture, selection);
      const rows = flattenVisibleExplorerRows(projection);
      matchVisibleRowKeys(rows, "dir-0001");
      selectableMatchPath(rows, rows[9_000].key);
    }

    expect(reader.reads).toEqual([]);
  });
});
