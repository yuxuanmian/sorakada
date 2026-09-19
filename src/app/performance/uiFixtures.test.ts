/**
 * T008/T009: the shared disposable UI fixtures must actually reach the scale the
 * acceptance criteria name, and must do it without touching the filesystem.
 */

import { describe, expect, it } from "vitest";

import { createDocumentId, type TabSnapshot } from "../document/documentSession";
import { revealTabOffset, tabOffsets } from "../tabs/tabLayout";
import {
  LARGE_TREE_TARGET_ROWS,
  countMaterializedRows,
  createLargeExplorerTree,
  createTenThousandRowExplorerTree,
} from "./treeFixtures";
import {
  FIXTURE_DOCUMENT_ID_PREFIX,
  MANY_TAB_FIXTURE_COUNT,
  activateFixtureTab,
  activeFixtureTab,
  closeFixtureTab,
  createHundredTabSnapshots,
  createManyTabSnapshots,
  fixtureDocumentId,
  isFixtureDocumentId,
} from "./tabFixtures";

describe("large Explorer tree fixture (T008)", () => {
  it("materializes at least 10,000 visible rows", () => {
    const state = createTenThousandRowExplorerTree();
    expect(countMaterializedRows(state)).toBeGreaterThanOrEqual(
      LARGE_TREE_TARGET_ROWS,
    );
  });

  it("every materialized directory is loaded and expanded", () => {
    const state = createLargeExplorerTree({ targetRows: 500 });
    const walk = (
      node: NonNullable<typeof state.root>,
    ): void => {
      if (node.kind !== "directory") {
        return;
      }
      expect(node.expanded).toBe(true);
      expect(node.loadState).toBe("loaded");
      for (const child of node.children ?? []) {
        if (child.kind === "directory") {
          walk(child);
        }
      }
    };
    walk(state.root!);
  });

  it("is deterministic for the same options", () => {
    const first = createLargeExplorerTree({ targetRows: 250 });
    const second = createLargeExplorerTree({ targetRows: 250 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("honours an explicit shape", () => {
    const state = createLargeExplorerTree({
      directoryCount: 3,
      filesPerDirectory: 4,
      depth: 2,
      rootPath: "C:\\shape",
    });
    // 1 root + 3 chains of (1 top-level dir + 1 nested dir + 4 files)
    expect(countMaterializedRows(state)).toBe(1 + 3 * 6);
  });

  it("can build deep rows with long names for horizontal-extent cases", () => {
    const state = createLargeExplorerTree({
      directoryCount: 1,
      filesPerDirectory: 1,
      depth: 6,
      namePadding: 200,
    });
    const root = state.root!;
    const top = root.children![0];
    expect(top.kind).toBe("directory");
    if (top.kind !== "directory") {
      return;
    }
    expect(top.name).toBe("dir-00000");
    let deepest = top;
    while (deepest.children?.[0]?.kind === "directory") {
      deepest = deepest.children[0];
    }
    expect(deepest.name).toBe("nested-5");
    expect(deepest.children?.[0]?.name.length).toBeGreaterThan(200);
  });
});

describe("many-Tab fixture (T009)", () => {
  it("produces 100 snapshots without creating documents", () => {
    const tabs = createHundredTabSnapshots();
    expect(tabs).toHaveLength(MANY_TAB_FIXTURE_COUNT);
    expect(tabs.every((tab) => tab.id.startsWith("fixture-doc-"))).toBe(true);
  });

  it("marks the active Tab, dirty Tabs and external state", () => {
    const tabs = createManyTabSnapshots({
      count: 10,
      activeIndex: 4,
      dirtyEvery: 2,
      externalEvery: 5,
      missingIndex: 3,
    });

    expect(tabs.filter((tab) => tab.active).map((tab) => tab.id)).toEqual([
      fixtureDocumentId(4),
    ]);
    expect(tabs[0].dirty).toBe(true);
    expect(tabs[1].dirty).toBe(false);
    expect(tabs[3].externalState).toBe("missing");
    expect(tabs[5].externalState).toBe("modified");
    expect(tabs[1].externalState).toBe("normal");
  });

  it("supports zero and single Tab cases", () => {
    expect(createManyTabSnapshots({ count: 0 })).toHaveLength(0);
    expect(createManyTabSnapshots({ count: 1 })).toHaveLength(1);
  });
});

/**
 * T227: while the fixture is enabled it owns its own Tabs.
 *
 * The fixture is a projection, not a document set: a click on one of its Tabs has to
 * move the *fixture's* active marker — that marker is what the strip's reveal rule
 * reacts to — and must never be handed to `DocumentManager`, which has no session
 * for a fixture id.
 */
describe("many-Tab fixture interaction state (T227)", () => {
  it("keeps fixture ids out of the document manager's id space", () => {
    expect(FIXTURE_DOCUMENT_ID_PREFIX).toBe("fixture-doc-");
    expect(isFixtureDocumentId(fixtureDocumentId(0))).toBe(true);
    expect(isFixtureDocumentId(createHundredTabSnapshots()[0].id)).toBe(true);
    // Real ids are `doc-<n>`, so the two families cannot collide and routing a Tab
    // gesture by identity is safe.
    expect(isFixtureDocumentId(createDocumentId())).toBe(false);
    expect(isFixtureDocumentId("doc-1")).toBe(false);
  });

  it("activates exactly one fixture Tab and leaves the others identical", () => {
    const tabs = createManyTabSnapshots({ count: 5, activeIndex: 0 });
    const next = activateFixtureTab(tabs, fixtureDocumentId(3));

    expect(next.filter((tab) => tab.active).map((tab) => tab.id)).toEqual([
      fixtureDocumentId(3),
    ]);
    expect(activeFixtureTab(next)?.id).toBe(fixtureDocumentId(3));
    // Exactly two Tabs change identity: the one that lost the marker and the one
    // that gained it. Every other Tab is the very same object.
    expect(next.map((tab, index) => tab !== tabs[index])).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it("ignores an id the fixture does not contain", () => {
    const tabs = createManyTabSnapshots({ count: 3, activeIndex: 1 });

    // A real document id can never be interpreted as a fixture Tab.
    expect(activateFixtureTab(tabs, "doc-12")).toBe(tabs);
    expect(closeFixtureTab(tabs, "doc-12")).toBe(tabs);
    expect(activeFixtureTab(tabs)?.id).toBe(fixtureDocumentId(1));
  });

  it("triggers the strip's reveal rule for the newly active Tab", () => {
    // Activation is what the strip's reveal effect reacts to, so an activation far
    // down the strip has to move the active index and produce a scroll offset that
    // brings that Tab into the viewport.
    const tabs = createHundredTabSnapshots();
    const widths = Array.from({ length: MANY_TAB_FIXTURE_COUNT }, () => 72);
    const offsets = tabOffsets(widths);
    const contentWidth = widths.reduce((total, width) => total + width, 0);
    const viewportWidth = 480;

    const before = revealTabOffset({
      scrollLeft: 0,
      viewportWidth,
      contentWidth,
      tabStart: offsets[0],
      tabWidth: widths[0],
    });
    const activated = activateFixtureTab(tabs, fixtureDocumentId(90));
    const activeIndex = activated.findIndex((tab) => tab.active);
    const after = revealTabOffset({
      scrollLeft: 0,
      viewportWidth,
      contentWidth,
      tabStart: offsets[activeIndex],
      tabWidth: widths[activeIndex],
    });

    expect(activeIndex).toBe(90);
    expect(after).toBeGreaterThan(before);
    expect(offsets[activeIndex] + widths[activeIndex]).toBeLessThanOrEqual(
      after + viewportWidth,
    );
  });

  it("closes harmlessly: one fewer fixture Tab, still exactly one active", () => {
    const tabs = createManyTabSnapshots({ count: 4, activeIndex: 1 });
    const closed = closeFixtureTab(tabs, fixtureDocumentId(1));

    expect(closed.map((tab) => tab.id)).toEqual([
      fixtureDocumentId(0),
      fixtureDocumentId(2),
      fixtureDocumentId(3),
    ]);
    // The neighbour that slid into the closed Tab's place takes the marker, so the
    // strip always has exactly one active Tab to reveal.
    expect(activeFixtureTab(closed)?.id).toBe(fixtureDocumentId(2));
    // Nothing was mutated: the fixture list is the only thing that changed.
    expect(tabs).toHaveLength(4);
    expect(activeFixtureTab(tabs)?.id).toBe(fixtureDocumentId(1));
  });

  it("keeps the active marker when an inactive fixture Tab is closed", () => {
    const tabs = createManyTabSnapshots({ count: 3, activeIndex: 1 });
    expect(activeFixtureTab(closeFixtureTab(tabs, fixtureDocumentId(0)))?.id).toBe(
      fixtureDocumentId(1),
    );
    expect(activeFixtureTab(closeFixtureTab(tabs, fixtureDocumentId(2)))?.id).toBe(
      fixtureDocumentId(1),
    );
  });

  it("closes the last fixture Tab without leaving a stale active marker", () => {
    const tabs = createManyTabSnapshots({ count: 1, activeIndex: 0 });
    expect(closeFixtureTab(tabs, tabs[0].id)).toEqual([]);
  });

  it("closes a dirty fixture Tab with no unsaved-changes machinery", () => {
    // `dirtyEvery: 1` marks every fixture Tab dirty. Closing one is still a plain
    // list operation, because a fixture Tab has no document to guard and no file to
    // write: nothing here can reach the unsaved-changes flow.
    const tabs = createManyTabSnapshots({ count: 3, dirtyEvery: 1, activeIndex: 0 });
    expect(tabs.every((tab) => tab.dirty)).toBe(true);

    const closed = closeFixtureTab(tabs, tabs[0].id);
    expect(closed).toHaveLength(2);
    expect(activeFixtureTab(closed)?.id).toBe(tabs[1].id);
  });

  it("closes every fixture Tab down to an empty strip", () => {
    let tabs: readonly TabSnapshot[] = createManyTabSnapshots({
      count: 20,
      activeIndex: 7,
    });
    for (const tab of createManyTabSnapshots({ count: 20 })) {
      tabs = closeFixtureTab(tabs, tab.id);
    }
    expect(tabs).toHaveLength(0);
    expect(activeFixtureTab(tabs)).toBeNull();
  });
});
