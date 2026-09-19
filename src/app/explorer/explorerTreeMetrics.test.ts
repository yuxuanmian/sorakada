/**
 * T083/T086: horizontal extent under virtualization.
 *
 * SC-006's rule is that a Tree row which is currently outside the vertical
 * viewport must still contribute to the horizontal scrollbar, without mounting
 * every row and without reading the filesystem. These tests use an injected
 * deterministic measurer, so the arithmetic — not a browser — is what is verified.
 */

import { describe, expect, it, vi } from "vitest";

import densityCss from "../../styles/density.css?raw";

import { DENSITY_METRICS } from "../shell/density";
import { createTenThousandRowExplorerTree } from "../performance/treeFixtures";
import {
  createApproximateLabelMeasurer,
  createCanvasLabelMeasurer,
  createCachingMeasurer,
  fontSignatureFor,
} from "../shell/textMeasurement";
import type { ExplorerDirectoryNode } from "./explorerModel";
import { flattenVisibleExplorerRows, type VisibleExplorerRow } from "./explorerProjection";
import {
  TREE_AFFORDANCE_SLACK,
  activeDescendantFor,
  computeTreeHorizontalExtent,
  minimumRowWidth,
  rowIndent,
  rowLabel,
  treeAffordances,
  treeRowDomId,
  withPinnedIndex,
  type TreeLabelMeasurer,
} from "./explorerTreeMetrics";

/** Deterministic measurer: one width per character, plus a fixed prefix. */
function measurer(perCharacter = 6, prefix = 0): TreeLabelMeasurer {
  return {
    fontSignature: "13px test",
    measure: (text) => prefix + text.length * perCharacter,
  };
}

function treeState(depth: number, fileNameLength: number) {
  const root: ExplorerDirectoryNode = {
    name: "work",
    path: "C:\\work",
    kind: "directory",
    isSymlink: false,
    objectIdentity: null,
    expanded: true,
    loadState: "loaded",
    children: [],
  };
  let current: ExplorerDirectoryNode = root;
  for (let level = 0; level < depth; level += 1) {
    const child: ExplorerDirectoryNode = {
      name: `level-${level}`,
      path: `${current.path}\\level-${level}`,
      kind: "directory",
      isSymlink: false,
      objectIdentity: null,
      expanded: true,
      loadState: "loaded",
      children: [],
    };
    current.children = [child];
    current = child;
  }
  current.children = [
    {
      name: `${"x".repeat(fileNameLength)}.ts`,
      path: `${current.path}\\${"x".repeat(fileNameLength)}.ts`,
      kind: "file",
      isSymlink: false,
      objectIdentity: null,
    },
  ];
  return {
    contextId: "workspace-1",
    generation: 1,
    root,
    selectedPath: null,
    inlineEdit: null,
    rootUnavailable: false,
  };
}

function rowsOf(state: ReturnType<typeof treeState>): VisibleExplorerRow[] {
  return flattenVisibleExplorerRows(state);
}

describe("row geometry", () => {
  it("scales indentation with depth from the density metric", () => {
    expect(rowIndent(0, DENSITY_METRICS.compact)).toBe(0);
    expect(rowIndent(3, DENSITY_METRICS.compact)).toBe(
      3 * DENSITY_METRICS.compact.treeIndent,
    );
    expect(rowIndent(3, DENSITY_METRICS.comfortable)).toBeGreaterThan(
      rowIndent(3, DENSITY_METRICS.compact),
    );
  });

  it("derives every affordance width from the density metrics", () => {
    const compact = treeAffordances(DENSITY_METRICS.compact);
    const comfortable = treeAffordances(DENSITY_METRICS.comfortable);

    expect(compact.chevron).toBe(DENSITY_METRICS.compact.treeChevronSize);
    expect(comfortable.chevron).toBe(
      DENSITY_METRICS.comfortable.treeChevronSize,
    );
    expect(compact.slack).toBe(TREE_AFFORDANCE_SLACK);
  });

  it("adds the badge width only for a linked entry", () => {
    const state = treeState(1, 3);
    const rows = rowsOf(state);
    const file = rows[rows.length - 1];
    const affordances = treeAffordances(DENSITY_METRICS.default);

    const plain = minimumRowWidth(file, DENSITY_METRICS.default, affordances);
    if (file.kind === "node") {
      file.node.isSymlink = true;
    }
    const linked = minimumRowWidth(file, DENSITY_METRICS.default, affordances);

    expect(linked - plain).toBe(affordances.badge);
  });

  it("labels a sentinel row with its message", () => {
    const state = treeState(1, 3);
    const rows = rowsOf(state);
    state.root.children = [
      {
        name: "src",
        path: "C:\\work\\src",
        kind: "directory",
        isSymlink: false,
        objectIdentity: null,
        expanded: true,
        loadState: "loading",
        children: undefined,
      },
    ];
    const loadingRows = rowsOf(state);
    const notice = loadingRows.find((row) => row.kind === "notice");
    expect(notice).toBeDefined();
    expect(rowLabel(notice!)).toBe("Loading...");
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("horizontal extent", () => {
  it("grows with depth and with the widest label", () => {
    const shallow = computeTreeHorizontalExtent({
      rows: rowsOf(treeState(0, 4)),
      metrics: DENSITY_METRICS.default,
      measurer: measurer(),
    });
    const deep = computeTreeHorizontalExtent({
      rows: rowsOf(treeState(6, 4)),
      metrics: DENSITY_METRICS.default,
      measurer: measurer(),
    });
    const wide = computeTreeHorizontalExtent({
      rows: rowsOf(treeState(6, 60)),
      metrics: DENSITY_METRICS.default,
      measurer: measurer(),
    });

    expect(deep.contentWidth).toBeGreaterThan(shallow.contentWidth);
    expect(wide.contentWidth).toBeGreaterThan(deep.contentWidth);
  });

  it("accounts for a widest row that is outside the vertical viewport (SC-006)", () => {
    // The widest row is the *deepest* one, which a 1200x780 window with a 22px
    // row height would never mount at scroll offset 0.
    const state = treeState(40, 200);
    const rows = rowsOf(state);
    const extent = computeTreeHorizontalExtent({
      rows,
      metrics: DENSITY_METRICS.default,
      measurer: measurer(),
    });

    expect(extent.widestKey).toBe(rows[rows.length - 1].key);
    expect(extent.contentWidth).toBeGreaterThan(40 * DENSITY_METRICS.default.treeIndent);
  });

  it("is empty for an empty projection", () => {
    const extent = computeTreeHorizontalExtent({
      rows: [],
      metrics: DENSITY_METRICS.default,
      measurer: measurer(),
    });
    expect(extent).toEqual({
      contentWidth: 0,
      widestKey: null,
      widestLabel: null,
    });
  });

  it("never reads anything but the strings it is handed (FR-044)", () => {
    const spy = vi.fn((text: string) => text.length);
    const extent = computeTreeHorizontalExtent({
      rows: rowsOf(treeState(2, 5)),
      metrics: DENSITY_METRICS.default,
      measurer: { fontSignature: "13px test", measure: spy },
    });

    expect(extent.contentWidth).toBeGreaterThan(0);
    // Every measurement is a row label; nothing path-shaped or filesystem-shaped
    // is ever requested.
    for (const call of spy.mock.calls) {
      expect(typeof call[0]).toBe("string");
      expect(call[0]).not.toContain("\\");
    }
  });

  it("changes with density because indentation changes", () => {
    const rows = rowsOf(treeState(6, 10));
    const compact = computeTreeHorizontalExtent({
      rows,
      metrics: DENSITY_METRICS.compact,
      measurer: measurer(),
    });
    const comfortable = computeTreeHorizontalExtent({
      rows,
      metrics: DENSITY_METRICS.comfortable,
      measurer: measurer(),
    });

    expect(comfortable.contentWidth).toBeGreaterThan(compact.contentWidth);
  });
});

/**
 * T157: the virtualizer's row offsets are derived from the density table, so a
 * density switch moves every row rather than leaving stale geometry behind.
 */
describe("virtual row offsets follow the density metric", () => {
  const offsets = (rowHeight: number): number[] =>
    [0, 1, 2, 10, 100].map((index) => index * rowHeight);

  it("differs before and after a density switch", () => {
    expect(offsets(DENSITY_METRICS.compact.treeRowHeight)).not.toEqual(
      offsets(DENSITY_METRICS.default.treeRowHeight),
    );
    expect(offsets(DENSITY_METRICS.default.treeRowHeight)).not.toEqual(
      offsets(DENSITY_METRICS.comfortable.treeRowHeight),
    );
  });

  it("keeps an unchanged offset for the first row", () => {
    expect(offsets(DENSITY_METRICS.comfortable.treeRowHeight)[0]).toBe(0);
  });

  it("uses the same metric the stylesheet declares (no second constant)", () => {
    for (const density of ["compact", "default", "comfortable"] as const) {
      const block = densityCss.slice(
        densityCss.indexOf(`[data-density="${density}"]`),
      );
      const declared = Number(
        block
          .slice(0, block.indexOf("}"))
          .match(/--tree-row-height:\s*(\d+)px/)![1],
      );
      expect(declared).toBe(DENSITY_METRICS[density].treeRowHeight);
    }
  });
});

/**
 * T230: the accessible active-descendant pointer.
 *
 * `aria-activedescendant` has to name a mounted element, and the mounted set has
 * holes in it: an active inline editor whose row scrolled out of the viewport is
 * pinned into the set, so the mounted indexes are a viewport range *plus* one
 * distant index. Deriving mounted-ness from the first-to-last span would name a
 * row that is not in the DOM at all.
 */
describe("active descendant (T230)", () => {
  /** The viewport range `[100..120]` plus the pinned off-screen editor row. */
  const pinnedEditIndex = 5000;
  const viewportRange = Array.from({ length: 21 }, (_, offset) => 100 + offset);
  const mounted = withPinnedIndex(viewportRange, pinnedEditIndex);

  it("pins the editor row without filling the gap it creates", () => {
    expect(mounted).toHaveLength(viewportRange.length + 1);
    expect(mounted[0]).toBe(100);
    expect(mounted[mounted.length - 1]).toBe(pinnedEditIndex);
    expect(mounted).not.toContain(400);
  });

  it("leaves the mounted set unchanged when the pinned row is already mounted", () => {
    expect(withPinnedIndex(viewportRange, 105)).toEqual(viewportRange);
  });

  it("never references an unmounted row that lies inside the mounted span", () => {
    // 400 is between the first (100) and last (5000) mounted index, but it is not
    // mounted: the old first-to-last span check named `explorer-tree-row-400`,
    // an id no element carries.
    expect(activeDescendantFor(400, mounted)).toBeUndefined();
  });

  it("references a mounted row, including the pinned one", () => {
    expect(activeDescendantFor(100, mounted)).toBe(treeRowDomId(100));
    expect(activeDescendantFor(120, mounted)).toBe(treeRowDomId(120));
    expect(activeDescendantFor(pinnedEditIndex, mounted)).toBe(
      treeRowDomId(pinnedEditIndex),
    );
  });

  it("has no pointer for no selection or an empty mounted set", () => {
    expect(activeDescendantFor(-1, mounted)).toBeUndefined();
    expect(activeDescendantFor(100, [])).toBeUndefined();
  });

  it("agrees with the projection on a real 10,000-row fixture", () => {
    // The selected row survives virtualization (FR-037), but the *pointer* must
    // not, so assistive technology is never handed a dangling element reference.
    const state = createTenThousandRowExplorerTree();
    const rows = flattenVisibleExplorerRows(state);
    const selectedButUnmounted = rows.length - 1;
    const rowsMounted = withPinnedIndex(
      Array.from({ length: 30 }, (_, offset) => offset),
      500,
    );

    expect(activeDescendantFor(500, rowsMounted)).toBe(treeRowDomId(500));
    expect(activeDescendantFor(selectedButUnmounted, rowsMounted)).toBeUndefined();
  });
});

describe("label measurement", () => {
  it("caches per label so a re-measure is free", () => {
    const inner = vi.fn((text: string) => text.length * 7);
    const cached = createCachingMeasurer({
      fontSignature: "13px test",
      measure: inner,
    });

    expect(cached.measure("same")).toBe(28);
    expect(cached.measure("same")).toBe(28);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(cached.fontSignature).toBe("13px test");
  });

  it("reports the font signature so a font change invalidates the cache (T086)", () => {
    const first = createCachingMeasurer(measurer(6));
    const second = createCachingMeasurer({
      fontSignature: "16px other",
      measure: measurer(9).measure,
    });

    expect(first.fontSignature).not.toBe(second.fontSignature);
    expect(second.measure("abcd")).toBe(36);
  });

  it("builds the canvas signature from size and family", () => {
    expect(
      fontSignatureFor({ fontSize: "13px", fontFamily: "Segoe UI" }),
    ).toBe("13px Segoe UI");
  });

  it("falls back without a DOM instead of throwing", () => {
    expect(
      createCanvasLabelMeasurer({ fontSize: "13px", fontFamily: "x" }),
    ).toBeNull();

    const approximate = createApproximateLabelMeasurer({
      fontSize: "13px",
      fontFamily: "x",
    });
    expect(approximate.measure("abcd")).toBe(28);
    expect(approximate.measure("")).toBe(0);
  });
});
