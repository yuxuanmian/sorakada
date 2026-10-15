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

/**
 * The signed area of every subpath in one `d` attribute.
 *
 * Only the move/line/close commands the fallback glyphs actually use are
 * supported, which is enough to answer the two questions that matter for a
 * filled glyph: does a subpath enclose area at all, and does it wind against the
 * silhouette (and therefore subtract from it under the default nonzero rule)?
 */
function subpathAreas(data: string): number[] {
  const tokens = data.match(/[MmLlHhVvZz]|-?\d*\.?\d+/g) ?? [];
  const areas: number[] = [];
  let points: Array<readonly [number, number]> = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let command = "M";
  let index = 0;

  const close = (): void => {
    if (points.length === 0) {
      return;
    }
    let sum = 0;
    for (let n = 0; n < points.length; n += 1) {
      const [x1, y1] = points[n];
      const [x2, y2] = points[(n + 1) % points.length];
      sum += x1 * y2 - x2 * y1;
    }
    areas.push(sum / 2);
    points = [];
  };

  const read = (): number => {
    const value = Number(tokens[index]);
    index += 1;
    return value;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[MmLlHhVvZz]$/.test(token)) {
      command = token;
      index += 1;
      if (command === "Z" || command === "z") {
        close();
        x = startX;
        y = startY;
        continue;
      }
    }

    switch (command) {
      case "M":
      case "m": {
        close();
        const dx = read();
        const dy = read();
        x = command === "m" ? x + dx : dx;
        y = command === "m" ? y + dy : dy;
        startX = x;
        startY = y;
        points.push([x, y]);
        command = command === "m" ? "l" : "L";
        break;
      }
      case "L":
      case "l": {
        const dx = read();
        const dy = read();
        x = command === "l" ? x + dx : dx;
        y = command === "l" ? y + dy : dy;
        points.push([x, y]);
        break;
      }
      case "H":
      case "h": {
        const dx = read();
        x = command === "h" ? x + dx : dx;
        points.push([x, y]);
        break;
      }
      case "V":
      case "v": {
        const dy = read();
        y = command === "v" ? y + dy : dy;
        points.push([x, y]);
        break;
      }
      default: {
        index += 1;
        break;
      }
    }
  }

  close();
  return areas;
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

/**
 * 008 T102 / FR-048..FR-050: the filled generic draw mode.
 *
 * The draw mode is *rendering* metadata only. Resolution, the closed fallback
 * set and the no-special-file-mapping rule are all unchanged, which is what keeps
 * this a provider decision instead of a new icon subsystem.
 */
describe("the generic filesystem glyphs request filled mode (008 FR-048)", () => {
  it("fills the four generic primary glyphs", () => {
    expect(fileIcon(entry("a.txt", "file")).icon.drawMode).toBe("fill");
    expect(fileIcon(entry("src", "directory")).icon.drawMode).toBe("fill");
    expect(
      fileIcon(entry("src", "directory", { expanded: true })).icon.drawMode,
    ).toBe("fill");
    expect(fileIcon(entry("thing", "other")).icon.drawMode).toBe("fill");
  });

  it("keeps the link badge stroke-oriented over a filled primary glyph", () => {
    const linked = fileIcon(entry("src", "directory", { isSymlink: true }));
    expect(linked.icon.drawMode).toBe("fill");
    expect(linked.badge?.drawMode).toBe("stroke");
  });

  it("leaves every shell action descriptor on the 007 stroke default", () => {
    for (const id of ["plus", "close", "locate", "chevron-right"] as const) {
      expect(uiIcon(id).drawMode).toBeUndefined();
    }
  });

  it("keeps artwork behind every id it can request", () => {
    for (const id of FILE_ICON_FALLBACKS) {
      expect(ICON_GLYPHS[id as IconId]?.length, id).toBeGreaterThan(0);
    }
  });

  it("gives `other` a filled mark that survives the fill (008 FR-048, SR-004)", () => {
    // The renderer fills every path element in the same `currentColor`, so a mark
    // painted as its own `<path>` on top of the filled page body is invisible,
    // and the former mark `M6.5 9.5h3` enclosed no area even as a hole. Either
    // way `other` rendered exactly like `file`. The mark must live in the
    // silhouette's own `d` and wind the other way, so the default nonzero fill
    // rule subtracts it.
    //
    // The helper answers exactly that question, so pin it first.
    expect(subpathAreas("M0 0h3v3h-3z")).toEqual([9]);
    expect(subpathAreas("M0 0v3h3v-3z")).toEqual([-9]);

    const silhouette = subpathAreas(ICON_GLYPHS.other[0]);
    expect(silhouette.length).toBeGreaterThan(1);

    const [body, ...marks] = silhouette;
    expect(Math.abs(body)).toBeGreaterThan(0);

    const hole = marks.find(
      (mark) => Math.abs(mark) > 0 && Math.sign(mark) === -Math.sign(body),
    );
    expect(hole, "other has a subtracting mark").toBeDefined();
    // A hairline hole would not read at 16px; the mark needs real area.
    expect(Math.abs(hole ?? 0)).toBeGreaterThanOrEqual(4);

    // `file` keeps the plain page: adding a wedge hole would replace its clean
    // folded-corner silhouette with a rectangular notch.
    expect(subpathAreas(ICON_GLYPHS.file[0])).toHaveLength(1);
    expect(ICON_GLYPHS.other[0]).not.toBe(ICON_GLYPHS.file[0]);
  });

  it("adds no language mapping for special names", () => {
    // 008 FR-049: `.java`, `.html` and `.dart` join the earlier list, and all of
    // them must still resolve to the one generic file fallback.
    const specialNames = [
      ".gitignore",
      ".env",
      "package.json",
      "Cargo.toml",
      "docker-compose.yml",
      ".java",
      ".html",
      ".dart",
    ];

    for (const name of specialNames) {
      const resolution = fileIcon(entry(name, "file"));
      expect(resolution.icon.id, name).toBe("file");
      expect(resolution.icon.drawMode, name).toBe("fill");
      expect(resolution.badge, name).toBeUndefined();
    }
  });
});
