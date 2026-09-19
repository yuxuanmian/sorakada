/**
 * The 007 dependency boundary (T017, T074, T195).
 *
 * 007 requires that application/feature code never imports the headless primitive
 * directly: if it did, the dependency's API would become the feature contract and
 * later visual work would be back to fighting third-party internals. The
 * virtualizer has the same rule for a different reason — a virtualizer object
 * leaking into controller or business code would make Tree state ownership
 * ambiguous.
 *
 * These are static source properties, so they are checked by reading the
 * repository rather than by rendering anything.
 */

import { describe, expect, it } from "vitest";

import {
  collectSourceFiles,
  findPackageImports,
} from "../test-support/sourceInventory";

// Concatenated so this audit file does not itself look like an importing module.
const BASE_UI = "@base-ui" + "/react";
const REACT_VIRTUAL = "@tanstack" + "/react-virtual";

/** The one module allowed to know about the virtualizer (T195). */
const VIRTUALIZER_OWNER = "src/app/explorer/ExplorerVirtualTree.tsx";

/** The directory allowed to know about the headless primitives (FR-014). */
const UI_LAYER_PREFIX = "src/ui/";

const sourceFiles = collectSourceFiles("src", [".ts", ".tsx"]);

describe("Base UI import boundary (T017, FR-014)", () => {
  it("finds Base UI imports inside the Sorakada wrapper layer", () => {
    const imports = findPackageImports(sourceFiles, BASE_UI);
    // If this ever becomes zero, the audit is silently checking nothing: the
    // wrappers are the only legitimate consumers and they must exist.
    expect(imports.length).toBeGreaterThan(0);
    expect(
      imports.every((entry) => entry.file.startsWith(UI_LAYER_PREFIX)),
    ).toBe(true);
  });

  it("no file outside src/ui/** imports Base UI", () => {
    const violations = findPackageImports(sourceFiles, BASE_UI).filter(
      (entry) => !entry.file.startsWith(UI_LAYER_PREFIX),
    );
    expect(violations).toEqual([]);
  });

  it("reaches the dependency only through its documented entry points", () => {
    // A deep import (for example `@base-ui/react/internals/...`) would bind the
    // wrappers to undocumented structure, which FR-018 forbids.
    const allowedSpecifiers = new Set([
      `${BASE_UI}/menu`,
      `${BASE_UI}/context-menu`,
      // The Tab Overview needs interactive popup content (a filter field plus a
      // selectable list), which the menu keyboard model cannot host (T139).
      `${BASE_UI}/popover`,
    ]);
    const deepImports = findPackageImports(sourceFiles, BASE_UI).filter(
      (entry) => !allowedSpecifiers.has(entry.specifier),
    );
    expect(deepImports).toEqual([]);
  });
});

describe("virtualizer import boundary (T195)", () => {
  it("only the Explorer virtualization adapter imports the virtualizer", () => {
    const violations = findPackageImports(sourceFiles, REACT_VIRTUAL).filter(
      (entry) => entry.file !== VIRTUALIZER_OWNER,
    );
    expect(violations).toEqual([]);
  });
});
