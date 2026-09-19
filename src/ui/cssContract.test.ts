/**
 * The 007 CSS contract audit (T033, T194, FR-017..FR-019, SC-009).
 *
 * 007 owns a set of stylesheet rules that are easy to violate accidentally:
 * palette literals only in the central token layer, no `!important`, no
 * deep-selector escape hatches, no selectors into a dependency's internals, no
 * raw `z-index` outside the layer tokens, and no viewport-unit sizing of basic
 * controls.
 *
 * The audit runs over the whole 007-owned stylesheet set — `src/styles/*.css`
 * plus the wrapper CSS in `src/ui/**` — so a future component cannot quietly
 * reintroduce one of them.
 */

import { describe, expect, it } from "vitest";

import {
  auditCss,
  collectSourceFiles,
} from "../test-support/sourceInventory";

/** Only the central token layer may declare a literal colour or a raw layer. */
const TOKEN_FILES = ["src/styles/global.css"];

const styleFiles = collectSourceFiles("src/styles", [".css"]);
const wrapperFiles = collectSourceFiles("src/ui", [".css"]);

const findings = auditCss([...styleFiles, ...wrapperFiles], {
  tokenFiles: TOKEN_FILES,
});

describe("007 CSS contract", () => {
  it("audits the stylesheet set the feature owns", () => {
    expect(styleFiles.length).toBeGreaterThan(0);
    expect(wrapperFiles.length).toBeGreaterThan(0);
  });

  it("has no !important, deep selectors or dependency-internal selectors", () => {
    expect(
      findings.filter((finding) =>
        ["important", "deep-selector", "dependency-internal-selector"].includes(
          finding.rule,
        ),
      ),
    ).toEqual([]);
  });

  it("declares every palette literal in the central token layer", () => {
    expect(
      findings.filter((finding) => finding.rule.startsWith("palette-literal")),
    ).toEqual([]);
  });

  it("uses named layer tokens instead of ad-hoc z-index values", () => {
    expect(findings.filter((finding) => finding.rule === "raw-z-index")).toEqual(
      [],
    );
  });

  it("sizes controls in CSS logical pixels, not in viewport units", () => {
    expect(
      findings.filter((finding) => finding.rule === "viewport-unit"),
    ).toEqual([]);
  });
});
