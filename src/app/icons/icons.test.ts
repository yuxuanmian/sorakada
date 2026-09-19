/**
 * T029 / FR-056..FR-060: the icon provider contracts.
 *
 * The point of these tests is that *every* filesystem entry reaches a safe
 * fallback, and that adding a special-file or language rule later is a provider
 * change — a filename like `.gitignore` or `Cargo.toml` must not require new Tree
 * code, and must not change what the row renders today.
 */

import { describe, expect, it } from "vitest";

import type { WorkspaceEntryKind } from "../../services/workspaceFileService";
import {
  FILE_ICON_FALLBACKS,
  defaultFileIconProvider,
  fileIcon,
} from "./fileIconProvider";
import { ICON_GLYPHS } from "./glyphs";
import type { FileIconNode, IconId } from "./iconTypes";
import { createUiIconProvider, defaultUiIconProvider, uiIcon } from "./uiIconProvider";

function entry(
  name: string,
  kind: WorkspaceEntryKind,
  options: { isSymlink?: boolean; expanded?: boolean } = {},
): FileIconNode {
  return {
    name,
    kind,
    isSymlink: options.isSymlink ?? false,
    ...(options.expanded === undefined ? {} : { expanded: options.expanded }),
    path: `C:\\fixture\\${name}`,
  };
}

describe("default UI icon provider", () => {
  it("resolves every shell action glyph the 007 surfaces use", () => {
    const ids = [
      "chevron-right",
      "chevron-down",
      "new-file",
      "new-folder",
      "refresh",
      "rename",
      "delete",
      "plus",
      "close",
      "minimize",
      "maximize",
      "restore",
      "locate",
      "collapse-all",
      "more",
      "filter",
      "list",
    ] as const;

    for (const id of ids) {
      expect(defaultUiIconProvider.resolve(id).id).toBe(id);
    }
  });

  it("carries an accessible label only when one is given", () => {
    expect(uiIcon("locate").title).toBeUndefined();
    expect(uiIcon("locate", "Locate current file").title).toBe(
      "Locate current file",
    );
  });

  it("fails loudly for an id it has no glyph for", () => {
    const provider = createUiIconProvider({} as Record<string, readonly string[]> as never);
    expect(() => provider.resolve("locate")).toThrow();
  });

  it("draws every glyph with a non-empty path set", () => {
    for (const [id, paths] of Object.entries(ICON_GLYPHS)) {
      expect(paths.length, id).toBeGreaterThan(0);
      expect(paths.every((path) => path.length > 0), id).toBe(true);
    }
  });
});

describe("default file icon provider", () => {
  it("gives every entry kind a fallback glyph", () => {
    const kinds: readonly WorkspaceEntryKind[] = ["file", "directory", "other"];
    for (const kind of kinds) {
      const resolution = fileIcon(entry("thing", kind));
      expect(FILE_ICON_FALLBACKS).toContain(resolution.icon.id);
    }
  });

  it("distinguishes an expanded directory from a collapsed one", () => {
    expect(fileIcon(entry("src", "directory")).icon.id).toBe("folder");
    expect(fileIcon(entry("src", "directory", { expanded: true })).icon.id).toBe(
      "folder-open",
    );
  });

  it("keeps a link badge provider-driven rather than row-driven", () => {
    const plain = fileIcon(entry("src", "directory"));
    expect(plain.badge).toBeUndefined();

    const linked = fileIcon(entry("src", "directory", { isSymlink: true }));
    expect(linked.icon.id).toBe("folder");
    expect(linked.badge?.id).toBe("link");

    const linkedFile = fileIcon(entry("a.txt", "file", { isSymlink: true }));
    expect(linkedFile.icon.id).toBe("file");
    expect(linkedFile.badge?.id).toBe("link");
  });

  it("resolves a special or unknown filename to the same generic fallback", () => {
    // FR-059: a later mapping is a provider change. Today these names must not
    // produce a different glyph — and, more importantly, must not need a new
    // branch anywhere in the Tree.
    const specialNames = [
      ".gitignore",
      ".env",
      "package.json",
      "Cargo.toml",
      "docker-compose.yml",
      "Makefile",
      "no-extension",
      "UPPER.TXT",
    ];

    const ids = new Set(
      specialNames.map((name) => fileIcon(entry(name, "file")).icon.id),
    );
    expect([...ids]).toEqual(["file"]);
  });

  it("resolves a broken link as a displayable entry, never as a directory", () => {
    const broken = fileIcon(entry("gone", "other", { isSymlink: true }));
    expect(broken.icon.id).toBe("other");
    expect(broken.badge?.id).toBe("link");
  });

  it("returns one of the five declared fallbacks for every id it can name", () => {
    const resolutions = [
      fileIcon(entry("a", "file")),
      fileIcon(entry("a", "directory")),
      fileIcon(entry("a", "directory", { expanded: true })),
      fileIcon(entry("a", "other")),
      fileIcon(entry("a", "other", { isSymlink: true })),
    ];

    for (const resolution of resolutions) {
      expect(FILE_ICON_FALLBACKS).toContain(resolution.icon.id);
      for (const descriptor of [resolution.icon, resolution.badge]) {
        if (descriptor !== undefined) {
          expect(ICON_GLYPHS[descriptor.id as IconId]).toBeDefined();
        }
      }
    }
  });

  it("exposes the fallbacks as the documented closed set", () => {
    expect(FILE_ICON_FALLBACKS).toEqual([
      "file",
      "folder",
      "folder-open",
      "other",
      "link",
    ]);
    expect(defaultFileIconProvider).toBeDefined();
  });
});
