/**
 * T144/T191: presentation stays out of the document model.
 *
 * FR-063 and FR-071 forbid storing Tab *presentation* (accent, big/merged style,
 * density, virtual/scroll state) in `DocumentSession`, and FR-070 forbids the Tab
 * surfaces from opening a path. Both are source properties, so they are checked by
 * reading the source rather than by rendering.
 */

import { describe, expect, it } from "vitest";

import { collectSourceFiles } from "../../test-support/sourceInventory";

const sessionSource = collectSourceFiles("src/app/document", [".ts"]).find(
  (file) => file.relativePath === "src/app/document/documentSession.ts",
);

const tabSources = collectSourceFiles("src/app/tabs", [".ts", ".tsx"]).filter(
  (file) => !file.relativePath.endsWith(".test.ts"),
);

describe("DocumentSession carries no presentation state (T144)", () => {
  it("exists where the test expects it", () => {
    expect(sessionSource).toBeDefined();
  });

  it("declares none of the visual-only fields 007 must not add", () => {
    const forbidden = [
      "accent",
      "groupStyle",
      "bigTab",
      "mergedTab",
      "rowIndex",
      "virtualStart",
      "density",
      "tabWidth",
      "pinned",
    ];

    for (const field of forbidden) {
      // A declaration or an assignment of one of these names, in any spelling.
      // (`scrollTop`/`scrollLeft` are deliberately *not* here: 001/002 own the
      // document reading position, which is not Tab presentation.)
      const pattern = new RegExp(`\\b${field}\\b`, "i");
      expect(pattern.test(sessionSource!.text), field).toBe(false);
    }
  });

  it("gains no 008 frame or surface state (T072)", () => {
    // 008 SR-002 frames every Tab in CSS only. The frame, its radius, gradient,
    // hover and accent must therefore stay out of the document model entirely
    // (008 FR-066): a model field would make Tab appearance document state.
    const forbidden = [
      "tabStyle",
      "frameStyle",
      "gradient",
      "radius",
      "hover",
      "shadow",
    ];

    for (const field of forbidden) {
      const pattern = new RegExp(`\\b${field}\\b`, "i");
      expect(pattern.test(sessionSource!.text), field).toBe(false);
    }
  });

  it("still owns exactly the document facts the UI projects", () => {
    for (const field of [
      "id",
      "path",
      "displayName",
      "format",
      "dirty",
      "externalState",
      "bindingGeneration",
    ]) {
      expect(sessionSource!.text).toContain(field);
    }
  });
});

describe("Tab surfaces never open a document (T191, FR-070)", () => {
  it("has no tab module that reaches the document-open path", () => {
    for (const file of tabSources) {
      expect(file.text, file.relativePath).not.toContain("openPath(");
      expect(file.text, file.relativePath).not.toContain("openPath:");
    }
  });

  it("routes selection through the manager's snapshot callback", () => {
    const strip = tabSources.find((file) =>
      file.relativePath.endsWith("TabStrip.tsx"),
    );
    expect(strip).toBeDefined();
    expect(strip!.text).toContain("onSelect(id: DocumentId)");
    expect(strip!.text).not.toContain("openPath");
  });

  it("keeps the Overview's activation contract to select + close", () => {
    const overview = tabSources.find((file) =>
      file.relativePath.endsWith("TabOverview.tsx"),
    );
    expect(overview).toBeDefined();
    expect(overview!.text).toContain("activateTabOverviewItem");
  });
});
