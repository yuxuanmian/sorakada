/**
 * The density contract is declared twice on purpose: `density.css` styles the
 * rows, and `density.ts` hands the virtualizer and the width estimator the same
 * numbers. This test is what keeps the two halves from drifting (Constitution
 * III, T023, T089, T157).
 */

import { describe, expect, it } from "vitest";

import css from "../../styles/density.css?raw";

import {
  DENSITY_CSS_VARIABLES,
  DENSITY_METRICS,
  UI_DENSITIES,
  densityMetrics,
} from "./density";
import { UI_DEBUG_OPTION_KEYS } from "./uiDebugState";

/** Pulls one `[data-density="..."]` (or `:root`) block out of the stylesheet. */
function blockFor(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `missing ${selector} in density.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function declaredPixels(block: string, variable: string): number {
  const match = block.match(
    new RegExp(`${variable}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`),
  );
  expect(match, `missing ${variable} in block`).not.toBeNull();
  return Number(match![1]);
}

describe("density tokens", () => {
  it("offers exactly the three presets the menu exposes", () => {
    expect(UI_DENSITIES).toEqual(["compact", "default", "comfortable"]);
    expect(Object.keys(DENSITY_METRICS).sort()).toEqual(
      [...UI_DENSITIES].sort(),
    );
  });

  it("uses a different metric set per preset", () => {
    const serialized = UI_DENSITIES.map((density) =>
      JSON.stringify(DENSITY_METRICS[density]),
    );
    expect(new Set(serialized).size).toBe(UI_DENSITIES.length);
  });

  it("keeps every structural metric positive", () => {
    for (const density of UI_DENSITIES) {
      for (const [key, value] of Object.entries(DENSITY_METRICS[density])) {
        expect(value, `${density}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps Tab min below Tab max so shrink-to-minimum is possible", () => {
    for (const density of UI_DENSITIES) {
      const metrics = DENSITY_METRICS[density];
      expect(metrics.tabMinWidth).toBeLessThan(metrics.tabMaxWidth);
    }
  });

  it("orders Compact < Default < Comfortable for row height", () => {
    expect(DENSITY_METRICS.compact.treeRowHeight).toBeLessThan(
      DENSITY_METRICS.default.treeRowHeight,
    );
    expect(DENSITY_METRICS.default.treeRowHeight).toBeLessThan(
      DENSITY_METRICS.comfortable.treeRowHeight,
    );
  });

  /*
   * 008 T024, FR-040, SC-006: the only structural metric 008 moves is the Tree
   * row height, and it moves by the plan's frozen amount. Compact stays the
   * densest practical mode; the change is +2px on Default and Comfortable, not a
   * global control enlargement.
   */
  it("freezes the 008 Tree row heights at 20/24/28", () => {
    expect(DENSITY_METRICS.compact.treeRowHeight).toBe(20);
    expect(DENSITY_METRICS.default.treeRowHeight).toBe(24);
    expect(DENSITY_METRICS.comfortable.treeRowHeight).toBe(28);
  });

  it("leaves every non-Tree metric at its 007 value (008 FR-040)", () => {
    expect(DENSITY_METRICS.compact).toMatchObject({
      treeIndent: 12,
      treeChevronSize: 14,
      tabHeight: 26,
      tabMinWidth: 64,
      tabMaxWidth: 200,
      menuItemHeight: 22,
      controlHeight: 22,
      topBarHeight: 30,
      footerHeight: 20,
      sidebarDefaultWidth: 240,
      gap: 3,
    });
    expect(DENSITY_METRICS.default).toMatchObject({
      treeIndent: 14,
      treeChevronSize: 16,
      tabHeight: 30,
      tabMinWidth: 72,
      tabMaxWidth: 220,
      menuItemHeight: 26,
      controlHeight: 24,
      topBarHeight: 34,
      footerHeight: 22,
      sidebarDefaultWidth: 260,
      gap: 4,
    });
    expect(DENSITY_METRICS.comfortable).toMatchObject({
      treeIndent: 18,
      treeChevronSize: 18,
      tabHeight: 34,
      tabMinWidth: 84,
      tabMaxWidth: 260,
      menuItemHeight: 30,
      controlHeight: 28,
      topBarHeight: 38,
      footerHeight: 26,
      sidebarDefaultWidth: 300,
      gap: 6,
    });
  });
});

describe("density.css agrees with the metric table", () => {
  it("declares the default preset on :root", () => {
    const root = blockFor(":root");
    for (const [key, variable] of Object.entries(DENSITY_CSS_VARIABLES)) {
      expect(
        declaredPixels(root, variable),
        `${variable} in :root`,
      ).toBe(DENSITY_METRICS.default[key as keyof typeof DENSITY_METRICS.default]);
    }
  });

  it.each(UI_DENSITIES)("declares every %s metric", (density) => {
    const block = blockFor(`[data-density="${density}"]`);
    for (const [key, variable] of Object.entries(DENSITY_CSS_VARIABLES)) {
      expect(declaredPixels(block, variable), `${variable} in ${density}`).toBe(
        DENSITY_METRICS[density][key as keyof typeof DENSITY_METRICS.default],
      );
    }
  });

  it("does not change typography with density (FR-081, T160)", () => {
    for (const density of UI_DENSITIES) {
      const block = blockFor(`[data-density="${density}"]`);
      expect(block).not.toContain("--font");
    }
  });
});

describe("density helpers", () => {
  it("resolves the metrics for one preset", () => {
    expect(densityMetrics("compact")).toBe(DENSITY_METRICS.compact);
  });

  it("keeps debug diagnostics out of the persisted density table (T178)", () => {
    for (const key of UI_DEBUG_OPTION_KEYS) {
      expect(Object.keys(DENSITY_METRICS.default)).not.toContain(key);
    }
  });
});
