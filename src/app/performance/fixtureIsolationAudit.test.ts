/**
 * The wiring half of the disposable-fixture isolation (T227, T229).
 *
 * The behavioural boundaries are pinned by `uiFixtures.test.ts` (the Tab fixture's
 * own state transitions) and `explorerFixtureIsolation.test.ts` (the Explorer
 * fixture's selection routing, against a real controller). What neither of those can
 * see is whether the *components* actually use those decisions: a fixture path
 * reaches the real application only through one careless call site, and the T229
 * defect was exactly that — an effect calling `controller.selectPath()` with a
 * quick-search match while a fixture was rendered.
 *
 * These are static source properties, so they are checked by reading the repository,
 * in the same way the menu-registration, dependency-boundary and icon audits are.
 */

import { describe, expect, it } from "vitest";

import { collectSourceFiles } from "../../test-support/sourceInventory";

const parts = collectSourceFiles("src/app", [".ts", ".tsx"]);

function sourceText(relativePath: string): string {
  const file = parts.find((entry) => entry.relativePath === relativePath);
  if (file === undefined) {
    throw new Error(`Expected ${relativePath} in the audited source tree`);
  }
  return file.text;
}

/** The text between two markers, so an assertion can be scoped to one function. */
function sliceBetween(
  text: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = text.indexOf(startMarker);
  expect(start, `missing marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing marker: ${endMarker}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const APP = "src/app/App.tsx";
const EXPLORER = "src/app/explorer/Explorer.tsx";
const VIRTUAL_TREE = "src/app/explorer/ExplorerVirtualTree.tsx";

describe("Tab gestures reach the document manager only through the fixture guard (T227)", () => {
  const app = sourceText(APP);

  it("the strip uses the routed callbacks, not inline manager calls", () => {
    expect(app).toContain("onSelect={selectTab}");
    expect(app).toContain("onClose={closeTab}");
  });

  it("selection is decided by the fixture id before the manager sees it", () => {
    // Exactly one call site: the Tab path. The `file.close` command has its own,
    // which is why the count is asserted per callback rather than per file.
    expect(countOccurrences(app, "manager.selectDocument(")).toBe(1);

    const selectTab = sliceBetween(
      app,
      "const selectTab = useCallback(",
      "const closeTab = useCallback(",
    );
    const guard = selectTab.indexOf("isFixtureDocumentId(id)");
    const manager = selectTab.indexOf("manager.selectDocument(");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(manager).toBeGreaterThan(guard);
    expect(selectTab).toContain("activateFixtureTab(current, id)");
  });

  it("closing routes the same way, so a fixture close is harmless", () => {
    const closeTab = sliceBetween(
      app,
      "const closeTab = useCallback(",
      "[manager],\n  );",
    );
    const guard = closeTab.indexOf("isFixtureDocumentId(id)");
    const manager = closeTab.indexOf("manager.closeDocument(");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(manager).toBeGreaterThan(guard);
    expect(closeTab).toContain("closeFixtureTab(current, id)");
  });
});

describe("Tree selection reaches the controller only through the fixture route (T229)", () => {
  const explorer = sourceText(EXPLORER);

  it("writes the controller's selection exactly once, inside the router", () => {
    expect(countOccurrences(explorer, "controller.selectPath(")).toBe(1);

    const applySelection = sliceBetween(
      explorer,
      "const applySelection = useCallback(",
      "const search = useExplorerQuickSearch(",
    );
    expect(applySelection).toContain("routeExplorerSelection({ fixture, path })");
    expect(applySelection).toContain("controller.selectPath(route.path)");
    // The fixture branch must be handled before the controller branch.
    expect(applySelection.indexOf('route.owner === "fixture"')).toBeLessThan(
      applySelection.indexOf("controller.selectPath(route.path)"),
    );
  });

  it("decides the harness from the fixture's own marker", () => {
    expect(explorer).toContain("isFixtureExplorerState(debugState)");
    expect(explorer).toContain(
      "fixtureExplorerProjection(fixture, fixtureSelection)",
    );
    // The rendered state must not be taken from the raw prop: a state that is not
    // the fixture has to render as the real Tree.
    expect(explorer).not.toContain("debugState ?? state");
  });

  it("renders the fixture without a Workspace and without real actions", () => {
    expect(explorer).toContain("renderedState.contextId === null");
    expect(explorer).toContain("suppressPopup={readOnly}");
    // The header's real-Workspace actions are withheld while a fixture is shown.
    expect(explorer).toContain("const headerActions = readOnly ? null : (");
    // No operation context is derived from the real controller while it is on.
    expect(explorer).toContain("readOnly || menuTargetPath === undefined");
  });
});

describe("the active descendant names a mounted row (T230)", () => {
  const tree = sourceText(VIRTUAL_TREE);

  it("tests mounted membership instead of the first-to-last span", () => {
    expect(tree).toContain("activeDescendantFor(");
    expect(tree).not.toContain("selectedIndex >= virtualStart");
    expect(tree).not.toContain("selectedIndex <= virtualEnd");
  });

  it("forms the mounted set with the shared pinning helper", () => {
    expect(tree).toContain("withPinnedIndex(defaultRangeExtractor(range), editRowIndex)");
  });
});
