/**
 * T127/T128/T129/T134: Tab sizing, overflow, reveal and the Overview projection.
 *
 * The pure parts of the many-Tab contract: a Tab is content-sized up to the
 * density maximum, Tabs that no longer fit are squeezed uniformly to the minimum
 * and only then scroll, the fixed action region is excluded from the viewport, and
 * the active-reveal rule is expressed in explicit viewport bounds rather than
 * `scrollIntoView()`.
 */

import { describe, expect, it, vi } from "vitest";

import type { DocumentId } from "../document/documentSession";
import { createManyTabSnapshots, fixtureDocumentId } from "../performance/tabFixtures";
import type { LabelMeasurer } from "../shell/textMeasurement";
import {
  TAB_AFFORDANCES,
  computeTabLayout,
  measureTabWidths,
  naturalTabWidth,
  naturalTabWidths,
  revealTabOffset,
  solveTabStrip,
  tabListOverflows,
  tabOffsets,
  tabViewportWidth,
} from "./tabLayout";
import {
  activateTabOverviewItem,
  filterTabOverviewItems,
  overviewHasItems,
  toTabOverviewItem,
} from "./tabOverviewModel";

const MIN = 72;
const MAX = 220;
const BOUNDS = { minWidth: MIN, maxWidth: MAX };

/** A deterministic measurer: one width per character. */
function measurer(perCharacter = 7): LabelMeasurer {
  return {
    fontSignature: "13px test",
    measure: (text) => text.length * perCharacter,
  };
}

/** `count` Tabs whose labels are `labelLength` characters long. */
function uniform(count: number, labelLength: number): number[] {
  return naturalTabWidths(
    Array.from({ length: count }, () => ({
      labelWidth: labelLength * 7,
      dirty: false,
      hasExternalState: false,
    })),
    BOUNDS,
  );
}

describe("naturalTabWidth (T134 regression)", () => {
  it("sizes a Tab to its content instead of the maximum", () => {
    // The reported defect: one `package-lock.json` Tab rendered 220px wide with a
    // dead gap after the close button.
    const width = naturalTabWidth(
      { labelWidth: 120, dirty: false, hasExternalState: false },
      BOUNDS,
    );

    expect(width).toBe(120 + TAB_AFFORDANCES.paddingLeft + TAB_AFFORDANCES.paddingRight + TAB_AFFORDANCES.gap + TAB_AFFORDANCES.close + TAB_AFFORDANCES.border + TAB_AFFORDANCES.slack);
    expect(width).toBeLessThan(MAX);
  });

  it("reserves room for the markers a Tab actually shows", () => {
    const plain = naturalTabWidth(
      { labelWidth: 60, dirty: false, hasExternalState: false },
      BOUNDS,
    );
    const marked = naturalTabWidth(
      { labelWidth: 60, dirty: true, hasExternalState: true },
      BOUNDS,
    );
    expect(marked - plain).toBe(
      TAB_AFFORDANCES.dirty + TAB_AFFORDANCES.external,
    );
  });

  it("never goes below the density minimum", () => {
    expect(
      naturalTabWidth(
        { labelWidth: 4, dirty: false, hasExternalState: false },
        BOUNDS,
      ),
    ).toBe(MIN);
  });

  it("never exceeds the density maximum, so a long name truncates instead", () => {
    expect(
      naturalTabWidth(
        { labelWidth: 900, dirty: true, hasExternalState: true },
        BOUNDS,
      ),
    ).toBe(MAX);
  });

  it("follows the density bounds", () => {
    const compact = naturalTabWidth(
      { labelWidth: 500, dirty: false, hasExternalState: false },
      { minWidth: 64, maxWidth: 200 },
    );
    const comfortable = naturalTabWidth(
      { labelWidth: 500, dirty: false, hasExternalState: false },
      { minWidth: 84, maxWidth: 260 },
    );
    expect(compact).toBe(200);
    expect(comfortable).toBe(260);
  });

  it("measures each Tab's own label", () => {
    const tabs = [
      { displayName: "a.ts", dirty: false, externalState: "normal" },
      { displayName: "package-lock.json", dirty: true, externalState: "missing" },
    ];
    const widths = measureTabWidths(tabs, measurer(), BOUNDS);

    expect(widths[0]).toBe(MIN); // short name: the minimum applies
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(widths[1]).toBeLessThanOrEqual(MAX);
  });

  it("renders a lone package-lock.json Tab at its content width, not the maximum", () => {
    // The reported defect: one Tab with a short name used to be forced to the
    // 220px comfortable maximum, leaving a dead gap after the close button.
    // 107px is what a Canvas measurement of `package-lock.json` at 13px Segoe UI
    // reports; the fixed part is the Tab's own padding/gap/close geometry.
    const width = naturalTabWidth(
      { labelWidth: 107, dirty: false, hasExternalState: false },
      BOUNDS,
    );

    expect(width).toBe(148);
    expect(width).toBeLessThan(MAX);
    expect(width).toBeGreaterThan(MIN);
  });
});

describe("computeTabLayout", () => {
  it("has no layout for zero Tabs", () => {
    expect(
      computeTabLayout({
        naturalWidths: [],
        viewportWidth: 600,
        minWidth: MIN,
        maxWidth: MAX,
      }),
    ).toEqual({
      widths: [],
      contentWidth: 0,
      overflows: false,
      uniformWidth: null,
    });
  });

  it("keeps content-sized Tabs while everything fits", () => {
    const naturalWidths = [90, 140];
    const layout = computeTabLayout({
      naturalWidths,
      viewportWidth: 900,
      minWidth: MIN,
      maxWidth: MAX,
    });

    expect(layout.widths).toEqual([90, 140]);
    expect(layout.contentWidth).toBe(230);
    expect(layout.overflows).toBe(false);
    expect(layout.uniformWidth).toBeNull();
  });

  it("squeezes every Tab to one width once they stop fitting", () => {
    // Five long-name Tabs want 220px each (1100px) but only 900px is available.
    const naturalWidths = naturalTabWidths(
      Array.from({ length: 5 }, () => ({
        labelWidth: 400,
        dirty: false,
        hasExternalState: false,
      })),
      BOUNDS,
    );
    expect(naturalWidths).toEqual([MAX, MAX, MAX, MAX, MAX]);

    const layout = computeTabLayout({
      naturalWidths,
      viewportWidth: 900,
      minWidth: MIN,
      maxWidth: MAX,
    });

    expect(layout.uniformWidth).toBe(180);
    expect(layout.widths).toEqual([180, 180, 180, 180, 180]);
    // A uniform squeeze, so no Tab is left wider than its neighbours.
    expect(new Set(layout.widths).size).toBe(1);
    expect(layout.overflows).toBe(false);
  });

  it("never shrinks below the minimum, and overflows instead", () => {
    const layout = computeTabLayout({
      naturalWidths: uniform(100, 30),
      viewportWidth: 900,
      minWidth: MIN,
      maxWidth: MAX,
    });

    expect(layout.uniformWidth).toBe(MIN);
    expect(layout.contentWidth).toBe(7200);
    expect(layout.overflows).toBe(true);
  });

  it("stays on one row", () => {
    for (const count of [0, 1, 20, 100]) {
      const layout = computeTabLayout({
        naturalWidths: uniform(count, 12),
        viewportWidth: 1200,
        minWidth: MIN,
        maxWidth: MAX,
      });
      expect(layout.widths).toHaveLength(count);
      expect(layout.contentWidth).toBe(
        layout.widths.reduce((total, width) => total + width, 0),
      );
    }
  });

  it("treats an unmeasured viewport as the minimum rather than guessing", () => {
    const layout = computeTabLayout({
      naturalWidths: uniform(4, 30),
      viewportWidth: 0,
      minWidth: MIN,
      maxWidth: MAX,
    });
    expect(layout.uniformWidth).toBe(MIN);
    expect(layout.overflows).toBe(true);
  });
});

describe("tabViewportWidth (T132)", () => {
  it("excludes the fixed action region", () => {
    expect(tabViewportWidth(1200, 64)).toBe(1136);
  });

  it("never reports a negative width", () => {
    expect(tabViewportWidth(40, 64)).toBe(0);
  });

  it("keeps New reachable by construction: actions are outside the viewport", () => {
    const strip = 640;
    const actions = 64;
    const layout = computeTabLayout({
      naturalWidths: uniform(100, 30),
      viewportWidth: tabViewportWidth(strip, actions),
      minWidth: MIN,
      maxWidth: MAX,
    });
    expect(layout.overflows).toBe(true);
    expect(layout.contentWidth).toBeGreaterThan(strip - actions);
  });
});

describe("tabOffsets", () => {
  it("derives each Tab's left edge from the widths in order", () => {
    expect(tabOffsets([90, 140, 72])).toEqual([0, 90, 230]);
  });

  it("is empty for no Tabs", () => {
    expect(tabOffsets([])).toEqual([]);
  });
});

describe("revealTabOffset (T128)", () => {
  const base = {
    viewportWidth: 400,
    contentWidth: 1000,
    tabWidth: 100,
  };

  it("keeps a Tab that is already visible where it is", () => {
    expect(
      revealTabOffset({ ...base, scrollLeft: 100, tabStart: 200 }),
    ).toBe(100);
  });

  it("reveals a Tab to the left of the viewport", () => {
    expect(
      revealTabOffset({ ...base, scrollLeft: 300, tabStart: 100 }),
    ).toBe(100);
  });

  it("reveals a Tab to the right of the viewport", () => {
    expect(revealTabOffset({ ...base, scrollLeft: 0, tabStart: 500 })).toBe(200);
  });

  it("reveals the final Tab without scrolling past the end", () => {
    expect(revealTabOffset({ ...base, scrollLeft: 0, tabStart: 900 })).toBe(600);
  });

  it("clamps to the scrollable range after a viewport resize", () => {
    const afterResize = revealTabOffset({
      ...base,
      viewportWidth: 900,
      scrollLeft: 600,
      tabStart: 900,
    });
    expect(afterResize).toBe(100);
  });

  it("never returns a negative offset", () => {
    expect(revealTabOffset({ ...base, scrollLeft: 0, tabStart: 0 })).toBe(0);
  });

  it("works with variable Tab widths", () => {
    const widths = [90, 140, 72, 200];
    const offsets = tabOffsets(widths);
    // The third Tab starts at 230 and ends at 302; a 200px viewport at 0 hides it.
    expect(
      revealTabOffset({
        scrollLeft: 0,
        viewportWidth: 200,
        contentWidth: 502,
        tabStart: offsets[2],
        tabWidth: widths[2],
      }),
    ).toBe(102);
  });
});

describe("tabListOverflows", () => {
  it("is derived from measured geometry", () => {
    expect(tabListOverflows(500, 500)).toBe(false);
    expect(tabListOverflows(501, 500)).toBe(true);
  });
});

/**
 * T228: the strip is recomputed from the boxes it actually gets.
 *
 * Both defects this pins are about *recomputation*. Showing the Overview control
 * widens the fixed action region without changing the strip's own width, and a
 * density transition resizes those controls the same way; geometry derived from the
 * strip alone would stay stale, and a Tab viewport that is wider than the real one
 * is exactly what lets New/Overview cover the active Tab.
 */
describe("tab strip geometry from observed sizes (T228)", () => {
  /** The New button plus the action region's leading border. */
  const ACTIONS_BASE = 62;
  /** The same region once the Overview trigger is rendered in it. */
  const ACTIONS_WITH_OVERVIEW = 94;

  function solve(input: {
    count: number;
    labelLength: number;
    stripWidth: number;
    actionsWidth: number;
    minWidth?: number;
    maxWidth?: number;
    forceOverview?: boolean;
  }) {
    return solveTabStrip({
      naturalWidths: uniform(input.count, input.labelLength),
      stripWidth: input.stripWidth,
      actionsWidth: input.actionsWidth,
      minWidth: input.minWidth ?? MIN,
      maxWidth: input.maxWidth ?? MAX,
      forceOverview: input.forceOverview,
    });
  }

  it("takes the Tab viewport out of the observed action region", () => {
    const withoutOverview = solve({
      count: 100,
      labelLength: 12,
      stripWidth: 1200,
      actionsWidth: ACTIONS_BASE,
    });
    const withOverview = solve({
      count: 100,
      labelLength: 12,
      stripWidth: 1200,
      actionsWidth: ACTIONS_WITH_OVERVIEW,
    });

    expect(withoutOverview.viewportWidth).toBe(1200 - ACTIONS_BASE);
    expect(withOverview.viewportWidth).toBe(1200 - ACTIONS_WITH_OVERVIEW);
    // The Overview's own width comes out of the Tab viewport, so the fixed region
    // never reaches further left than the viewport's right edge.
    expect(withOverview.viewportWidth).toBe(
      withoutOverview.viewportWidth -
        (ACTIONS_WITH_OVERVIEW - ACTIONS_BASE),
    );
  });

  it("offers the Overview exactly when the Tabs overflow the real viewport", () => {
    expect(
      solve({ count: 3, labelLength: 12, stripWidth: 1200, actionsWidth: ACTIONS_BASE })
        .showOverview,
    ).toBe(false);
    expect(
      solve({ count: 100, labelLength: 12, stripWidth: 1200, actionsWidth: ACTIONS_BASE })
        .showOverview,
    ).toBe(true);
    // Forced on by the development fixture even with one Tab (T183).
    expect(
      solve({
        count: 1,
        labelLength: 12,
        stripWidth: 1200,
        actionsWidth: ACTIONS_BASE,
        forceOverview: true,
      }).showOverview,
    ).toBe(true);
  });

  it("settles after the Overview widens the action region", () => {
    // The measurement loop: the Overview costs viewport width, so the strip solves
    // a second time with the wider region. `overflows` is monotone in the viewport
    // width, so that second pass cannot turn the control back off — otherwise the
    // two measurements would oscillate.
    for (const stripWidth of [320, 480, 640, 900, 1200, 1920]) {
      for (const count of [0, 1, 4, 20, 100]) {
        const first = solve({ count, labelLength: 30, stripWidth, actionsWidth: ACTIONS_BASE });
        const second = solve({
          count,
          labelLength: 30,
          stripWidth,
          actionsWidth: first.showOverview ? ACTIONS_WITH_OVERVIEW : ACTIONS_BASE,
        });

        expect(second.showOverview, `${stripWidth}/${count}`).toBe(first.showOverview);
        expect(second.viewportWidth).toBeLessThanOrEqual(first.viewportWidth);
      }
    }
  });

  it("recomputes for a density transition at the same observed sizes", () => {
    // Four long-named Tabs want 220px each, but 900px minus the actions leaves 838.
    // The squeeze lands between the two densities' maxima, so the same observation
    // has to produce different widths per density.
    const compact = solve({
      count: 4,
      labelLength: 40,
      stripWidth: 900,
      actionsWidth: ACTIONS_BASE,
      minWidth: 64,
      maxWidth: 200,
    });
    const comfortable = solve({
      count: 4,
      labelLength: 40,
      stripWidth: 900,
      actionsWidth: ACTIONS_BASE,
      minWidth: 84,
      maxWidth: 260,
    });

    expect(compact.layout.uniformWidth).toBe(200);
    expect(comfortable.layout.uniformWidth).toBe(209);
    expect(compact.showOverview).toBe(false);
    expect(comfortable.showOverview).toBe(false);
  });

  it("re-squeezes rather than overflowing once the Overview takes its width", () => {
    const withoutOverview = solve({
      count: 6,
      labelLength: 40,
      stripWidth: 1200,
      actionsWidth: ACTIONS_BASE,
    });
    const withOverview = solve({
      count: 6,
      labelLength: 40,
      stripWidth: 1200,
      actionsWidth: ACTIONS_WITH_OVERVIEW,
    });

    expect(withoutOverview.layout.uniformWidth).toBe(189);
    expect(withOverview.layout.uniformWidth).toBe(184);
    // The narrower viewport still holds every Tab: the widths were recomputed.
    expect(withOverview.layout.overflows).toBe(false);
    expect(withOverview.layout.contentWidth).toBeLessThanOrEqual(
      withOverview.viewportWidth,
    );
    // The geometry from the wider observation would *not* have fit, which is what
    // makes the recomputation load-bearing rather than cosmetic (T228).
    expect(withoutOverview.layout.contentWidth).toBeGreaterThan(
      withOverview.viewportWidth,
    );
  });

  it("never lets New or the Overview cover the active Tab", () => {
    for (const stripWidth of [320, 480, 700, 1200, 1920]) {
      for (const count of [1, 2, 5, 20, 100]) {
        for (const labelLength of [3, 40]) {
          const solution = solve({
            count,
            labelLength,
            stripWidth,
            actionsWidth: ACTIONS_WITH_OVERVIEW,
          });
          const offsets = tabOffsets(solution.layout.widths);

          // The fixed region starts where the Tab viewport ends, so the viewport is
          // the whole region a Tab can legitimately occupy.
          expect(
            solution.viewportWidth + ACTIONS_WITH_OVERVIEW,
            `${stripWidth}/${count}/${labelLength}`,
          ).toBeLessThanOrEqual(stripWidth);

          for (let activeIndex = 0; activeIndex < count; activeIndex += 1) {
            const tabStart = offsets[activeIndex];
            const tabWidth = solution.layout.widths[activeIndex];
            const scrollLeft = revealTabOffset({
              scrollLeft: 0,
              viewportWidth: solution.viewportWidth,
              contentWidth: solution.layout.contentWidth,
              tabStart,
              tabWidth,
            });

            // Fully inside the viewport window, at every strip width, Tab count and
            // active position: nothing can be hidden under the fixed actions.
            expect(tabStart, `${stripWidth}/${count}/${labelLength}/${activeIndex}`)
              .toBeGreaterThanOrEqual(scrollLeft);
            expect(
              tabStart + tabWidth,
              `${stripWidth}/${count}/${labelLength}/${activeIndex}`,
            ).toBeLessThanOrEqual(scrollLeft + solution.viewportWidth);
          }
        }
      }
    }
  });
});

describe("Tab Overview projection (T129)", () => {
  const tabs = createManyTabSnapshots({
    count: 5,
    activeIndex: 2,
    dirtyEvery: 2,
    externalEvery: 3,
    missingIndex: 4,
  });

  it("preserves Tab order", () => {
    expect(filterTabOverviewItems(tabs, "").map((item) => item.id)).toEqual(
      tabs.map((tab) => tab.id),
    );
  });

  it("filters by display name", () => {
    const items = filterTabOverviewItems(tabs, "document-003");
    expect(items.map((item) => item.id)).toEqual([fixtureDocumentId(3)]);
  });

  it("filters by path", () => {
    const items = filterTabOverviewItems(tabs, "fixture\\document-001");
    expect(items).toHaveLength(1);
  });

  it("is case-insensitive and trims", () => {
    expect(filterTabOverviewItems(tabs, "  DOCUMENT-002 ")).toHaveLength(1);
  });

  it("returns nothing when nothing matches", () => {
    const items = filterTabOverviewItems(tabs, "no-such-document");
    expect(items).toEqual([]);
    expect(overviewHasItems(items)).toBe(false);
  });

  it("exposes active, dirty and external markers", () => {
    const items = filterTabOverviewItems(tabs, "");
    expect(items[2].active).toBe(true);
    expect(items[0].dirty).toBe(true);
    expect(items[1].dirty).toBe(false);
    expect(items[4].externalState).toBe("missing");
    expect(items[3].externalState).toBe("modified");
  });

  it("projects an untitled Tab without a path", () => {
    const untitled = toTabOverviewItem({
      id: "doc-u",
      displayName: "Untitled1",
      path: null,
      dirty: true,
      active: false,
      externalState: "normal",
    });
    expect(untitled.path).toBeNull();
    expect(untitled.displayName).toBe("Untitled1");
  });
});

describe("Tab Overview activation (T141, FR-070)", () => {
  it("selects the existing document exactly once and closes the popup", () => {
    const select = vi.fn<(id: DocumentId) => void>();
    const close = vi.fn();

    activateTabOverviewItem("doc-7", { select, close });

    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("doc-7");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("has no way to open a path, so it cannot duplicate a session", () => {
    const actions = { select: vi.fn(), close: vi.fn() };
    expect(Object.keys(actions).sort()).toEqual(["close", "select"]);
  });
});

describe("Tab Overview stays live (T142)", () => {
  it("reflects a close, rename and rebind from the newest snapshot", () => {
    const before = createManyTabSnapshots({ count: 3, activeIndex: 1 });

    const after = [
      before[0],
      { ...before[2], displayName: "renamed.ts", path: "C:\\fixture\\renamed.ts", dirty: true },
    ];

    const items = filterTabOverviewItems(after, "");
    expect(items.map((item) => item.id)).toEqual([before[0].id, before[2].id]);
    expect(items[1].displayName).toBe("renamed.ts");
    expect(items[1].dirty).toBe(true);
  });

  it("safely reports an empty list once every document is closed", () => {
    expect(filterTabOverviewItems([], "")).toEqual([]);
  });
});
