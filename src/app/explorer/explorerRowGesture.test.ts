import { describe, expect, it } from "vitest";

import { completesExplorerDoubleClick } from "./explorerRowGesture";

describe("Explorer row multi-click gesture", () => {
  it("completes every pair in one uninterrupted rapid-click sequence", () => {
    expect(
      [1, 2, 3, 4, 5, 6].filter(completesExplorerDoubleClick),
    ).toEqual([2, 4, 6]);
  });

  it("works again when the browser starts a fresh click sequence", () => {
    expect([1, 2].filter(completesExplorerDoubleClick)).toEqual([2]);
    expect([1, 2].filter(completesExplorerDoubleClick)).toEqual([2]);
  });

  it("does not treat synthetic, invalid or single clicks as a double-click", () => {
    expect(completesExplorerDoubleClick(0)).toBe(false);
    expect(completesExplorerDoubleClick(1)).toBe(false);
    expect(completesExplorerDoubleClick(-2)).toBe(false);
    expect(completesExplorerDoubleClick(2.5)).toBe(false);
  });
});
