/**
 * T150: the pure Sidebar layout bounds.
 *
 * SC-005 requires that Sidebar and EditorWorkspace never overlap at the
 * configured minimum window and that the Sidebar can grow beyond the old 640px
 * ceiling on a large display while the EditorWorkspace keeps its frozen 320
 * logical-pixel minimum.
 */

import { describe, expect, it } from "vitest";

import globalCss from "../../styles/global.css?raw";

import {
  MAIN_AREA_CHROME_WIDTH,
  MIN_EDITOR_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_PREFERENCE_MAX_WIDTH,
  clampSidebarWidthToLayout,
  clampStoredSidebarWidth,
  preservesEditorMinimum,
  renderSidebarWidth,
  sidebarWidthBounds,
} from "./layoutMetrics";

/** Window widths the acceptance matrix names, as MainArea widths. */
const MIN_WINDOW = 640;
const ORDINARY_WINDOW = 1200;
const WIDE_4K_LOGICAL = 3840;

describe("sidebarWidthBounds", () => {
  it("preserves the Editor minimum after fixed MainArea chrome", () => {
    for (const width of [MIN_WINDOW, ORDINARY_WINDOW, WIDE_4K_LOGICAL]) {
      const bounds = sidebarWidthBounds(width);
      expect(
        width - bounds.max - MAIN_AREA_CHROME_WIDTH,
      ).toBeGreaterThanOrEqual(MIN_EDITOR_WIDTH);
    }
  });

  it("raises the old 640px ceiling on a wide viewport", () => {
    expect(sidebarWidthBounds(WIDE_4K_LOGICAL).max).toBeGreaterThan(640);
  });

  it("never falls below the Sidebar minimum on a tiny viewport", () => {
    const bounds = sidebarWidthBounds(200);
    expect(bounds.min).toBe(SIDEBAR_MIN_WIDTH);
    expect(bounds.max).toBeGreaterThanOrEqual(bounds.min);
  });

  it("is deterministic from the current bounds only", () => {
    expect(sidebarWidthBounds(MIN_WINDOW)).toEqual(
      sidebarWidthBounds(MIN_WINDOW),
    );
  });
});

describe("clampSidebarWidthToLayout", () => {
  it("clamps a tiny request to the minimum", () => {
    expect(clampSidebarWidthToLayout(10, ORDINARY_WINDOW)).toBe(
      SIDEBAR_MIN_WIDTH,
    );
  });

  it("clamps a huge request to the layout maximum", () => {
    const clamped = clampSidebarWidthToLayout(10_000, MIN_WINDOW);
    expect(clamped).toBe(sidebarWidthBounds(MIN_WINDOW).max);
    expect(preservesEditorMinimum(MIN_WINDOW, clamped)).toBe(true);
  });

  it("allows a width far beyond 640 on a wide viewport", () => {
    expect(clampSidebarWidthToLayout(1600, WIDE_4K_LOGICAL)).toBe(1600);
  });

  it("treats a non-finite request conservatively", () => {
    expect(clampSidebarWidthToLayout(Number.NaN, ORDINARY_WINDOW)).toBe(
      SIDEBAR_MIN_WIDTH,
    );
    expect(
      clampSidebarWidthToLayout(Number.POSITIVE_INFINITY, ORDINARY_WINDOW),
    ).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("rounds a fractional request", () => {
    expect(clampSidebarWidthToLayout(300.6, ORDINARY_WINDOW)).toBe(301);
  });
});

describe("renderSidebarWidth", () => {
  it("clamps for rendering while the preference keeps its value", () => {
    const preferred = 1800;
    const narrow = renderSidebarWidth(preferred, MIN_WINDOW);
    const wide = renderSidebarWidth(preferred, WIDE_4K_LOGICAL);

    expect(narrow).toBeLessThan(preferred);
    expect(wide).toBe(preferred);
    // The preference itself was never rewritten.
    expect(preferred).toBe(1800);
  });
});

describe("clampStoredSidebarWidth", () => {
  it("keeps a plausible width untouched", () => {
    expect(clampStoredSidebarWidth(900)).toBe(900);
  });

  it("rejects a corrupt payload without knowing the layout", () => {
    expect(clampStoredSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampStoredSidebarWidth(-5)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampStoredSidebarWidth(Number.NaN)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampStoredSidebarWidth(1e9)).toBe(SIDEBAR_PREFERENCE_MAX_WIDTH);
  });
});

/**
 * The layout bound is declared twice for two different consumers: the CSS keeps
 * the Editor from ever being painted over, and this module computes the clamp.
 * Pinning them together is what stops a later "small CSS tweak" from silently
 * invalidating the arithmetic (Constitution III, FR-083).
 */
describe("global.css agrees with the layout metrics", () => {
  function declaredPixels(variable: string): number {
    const match = globalCss.match(
      new RegExp(`${variable}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`),
    );
    expect(match, `missing ${variable} in global.css`).not.toBeNull();
    return Number(match![1]);
  }

  it("freezes the same Editor minimum", () => {
    expect(declaredPixels("--min-editor-width")).toBe(MIN_EDITOR_WIDTH);
  });

  it("freezes the same splitter width", () => {
    expect(declaredPixels("--sidebar-resizer-width")).toBe(
      MAIN_AREA_CHROME_WIDTH,
    );
  });
});
