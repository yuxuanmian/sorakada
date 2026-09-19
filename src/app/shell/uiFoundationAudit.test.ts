/**
 * T192/T193/T196/T197: the cross-cutting source audits.
 *
 * 007 makes several claims about what the *codebase* must not contain any more:
 * a native visible menu, duplicated glyphs in feature components, visual-only
 * fields in business models, and a second unsafe window-destroy path. Each is a
 * source property, so each is checked by reading the source.
 */

import { describe, expect, it } from "vitest";

import {
  collectSourceFiles,
  findPackageImports,
} from "../../test-support/sourceInventory";

const appSources = collectSourceFiles("src/app", [".ts", ".tsx"]);
const uiSources = collectSourceFiles("src/ui", [".ts", ".tsx"]);
const nonTest = (files: typeof appSources) =>
  files.filter((file) => !file.relativePath.endsWith(".test.ts") && !file.relativePath.endsWith(".test.tsx"));

describe("the native visible menu is retired (T073, SR-006)", () => {
  it("no longer imports Tauri's menu API anywhere", () => {
    const violations = findPackageImports(
      [...appSources, ...uiSources],
      "@tauri-apps/api/menu",
    );
    expect(violations).toEqual([]);
  });

  it("leaves no native-menu installation or availability-sync reference in App", () => {
    const app = nonTest(appSources).find(
      (file) => file.relativePath === "src/app/App.tsx",
    );
    expect(app).toBeDefined();
    for (const gone of [
      "installAppMenu",
      "AppMenuInstallation",
      "menuRef",
      "syncAvailability",
    ]) {
      expect(app!.text, gone).not.toContain(gone);
    }
  });

  it("has no appMenu installer module left", () => {
    expect(
      appSources.some(
        (file) => file.relativePath === "src/app/menu/appMenu.ts",
      ),
    ).toBe(false);
  });
});

describe("feature components do not fork icon glyphs (T193)", () => {
  it("draws SVG paths only in the icon provider layer", () => {
    // The signal is path *data* (`<path d=…>`), not the two-character sequence:
    // a comment that spells out a sentinel key shape (`<path>::notice:error`) is
    // not a glyph, and matching it would make this audit lie.
    const svgPathData = /<path\s[^>]*d=/;
    const withPaths = nonTest(appSources).filter((file) =>
      svgPathData.test(file.text),
    );
    expect(withPaths.map((file) => file.relativePath)).toEqual([
      "src/app/shell/AppIcon.tsx",
    ]);
  });

  it("keeps icon colour on currentColor", () => {
    const appIcon = nonTest(appSources).find((file) =>
      file.relativePath.endsWith("AppIcon.tsx"),
    );
    expect(appIcon!.text).toContain('stroke="currentColor"');
    // No palette literal may appear in a component.
    expect(/#[0-9a-fA-F]{3,8}\b/.test(appIcon!.text)).toBe(false);
  });
});

describe("visual-only state stays out of business models (T196)", () => {
  const models = [
    "src/app/document/documentSession.ts",
    "src/app/document/documentManager.ts",
    "src/app/explorer/explorerModel.ts",
  ];

  it("declares no presentation-only field in a domain model", () => {
    const forbidden = [
      "groupStyle",
      "bigTab",
      "mergedTab",
      "tabWidth",
      "rowIndex",
      "virtualStart",
      "virtualEnd",
      "renderedRowCount",
      "scrollTop",
      "accent",
      "density",
    ];

    for (const path of models) {
      const file = appSources.find((source) => source.relativePath === path);
      expect(file, path).toBeDefined();
      for (const field of forbidden) {
        // `scrollTop` is the deliberate exception: 001/002 own the document
        // reading position, which is document state rather than Tab styling.
        if (path.endsWith("documentSession.ts") && field === "scrollTop") {
          continue;
        }
        expect(
          new RegExp(`\\b${field}\\b`).test(file!.text),
          `${path}: ${field}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the virtual range reported, not stored", () => {
    // The virtualizer is localized to the Explorer adapter; a virtualizer object
    // must never reach controller or business code.
    const importers = findPackageImports(appSources, "@tanstack/react-virtual");
    expect(importers.map((entry) => entry.file)).toEqual([
      "src/app/explorer/ExplorerVirtualTree.tsx",
    ]);
  });
});

describe("only the approved path force-destroys the window (T197, FR-008)", () => {
  it("calls the native window destroy only from application exit", () => {
    const destroyCalls = nonTest(appSources).filter((file) =>
      /\.destroy\(\)/.test(file.text),
    );

    // The lifecycle's own `destroyWindow` dependency is passed in from App, and
    // `windowLifecycle.ts` is the module that *decides* when it may run.
    expect(destroyCalls.map((file) => file.relativePath).sort()).toEqual([
      "src/app/App.tsx",
      "src/app/window/windowLifecycle.ts",
    ]);
  });

  it("keeps the visual close control on the normal close request", () => {
    const chrome = nonTest(appSources).find((file) =>
      file.relativePath.endsWith("windowChrome.ts"),
    );
    expect(chrome!.text).toContain("close: () => appWindow.close()");
    // No destroy call and no destroy-shaped adapter member: the controller has no
    // way to bypass the close guard, even by accident.
    expect(/\.destroy\(/.test(chrome!.text)).toBe(false);
    expect(/destroy\s*:/.test(chrome!.text)).toBe(false);
  });

  it("never lets the TopBar call destroy", () => {
    const topBar = nonTest(appSources).find((file) =>
      file.relativePath.endsWith("TopBar.tsx"),
    );
    expect(/\.destroy\(/.test(topBar!.text)).toBe(false);
    expect(topBar!.text).toContain('onCommand("window.close")');
  });
});
