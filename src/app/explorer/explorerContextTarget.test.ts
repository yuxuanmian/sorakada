/**
 * T069/T102: the single controlled Explorer operation target.
 *
 * A right click names a *logical path*, resolved from the element the gesture
 * landed on. Nothing about the target depends on which row element happens to be
 * mounted, which is what lets the virtualized Tree recycle rows without ever
 * leaving a stale menu target behind.
 */

import { describe, expect, it } from "vitest";

import {
  EXPLORER_ROW_PATH_ATTRIBUTE,
  rowPathFromTarget,
} from "./explorerContextTarget";

/** A fake element that resolves the nearest ancestor carrying the attribute. */
function element(path: string | null, options: { rowIsSelf?: boolean } = {}) {
  const row =
    path === null
      ? null
      : {
          getAttribute: (name: string) =>
            name === EXPLORER_ROW_PATH_ATTRIBUTE ? path : null,
        };

  const own = options.rowIsSelf === true ? row : null;

  return {
    closest: (selector: string) =>
      selector === `[${EXPLORER_ROW_PATH_ATTRIBUTE}]` ? (own ?? row) : null,
  };
}

describe("rowPathFromTarget", () => {
  it("resolves the logical path of the row under the gesture", () => {
    expect(rowPathFromTarget(element("C:\\work\\src\\a.ts"))).toBe(
      "C:\\work\\src\\a.ts",
    );
  });

  it("resolves the row when the gesture landed on the row itself", () => {
    expect(
      rowPathFromTarget(element("C:\\work\\src", { rowIsSelf: true })),
    ).toBe("C:\\work\\src");
  });

  it("treats blank space as root context", () => {
    expect(rowPathFromTarget(element(null))).toBeNull();
  });

  it("treats an unknowable target as root context instead of throwing", () => {
    expect(rowPathFromTarget(null)).toBeNull();
    expect(rowPathFromTarget(undefined)).toBeNull();
    expect(rowPathFromTarget("div")).toBeNull();
    expect(rowPathFromTarget({})).toBeNull();
  });

  it("ignores an empty path attribute", () => {
    expect(rowPathFromTarget(element(""))).toBeNull();
  });

  it("publishes the attribute every row must carry", () => {
    expect(EXPLORER_ROW_PATH_ATTRIBUTE).toBe("data-explorer-row-path");
  });
});
