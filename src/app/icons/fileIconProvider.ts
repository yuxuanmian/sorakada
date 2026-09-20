/**
 * The default filesystem icon provider (007 T028, FR-057..FR-060).
 *
 * Explorer rows ask this provider instead of running their own `iconFor(node)`
 * extension/name branches, which is what makes a future language map, special-file
 * rule or file-icon theme a provider change rather than a Tree rewrite (FR-059).
 *
 * The default provider is deliberately minimal: folder/open-folder for
 * directories, a generic file glyph for files, a generic marked glyph for
 * "other" entries, and a link badge for symlinks/junctions. It never reads file
 * contents and never looks beyond the metadata it is handed (FR-060).
 *
 * 008 SR-004 adds one thing and nothing else: the four generic primary glyphs are
 * requested in the filled draw mode (008 FR-048). No filename, extension or
 * language branch appears here, and the `link` badge stays stroke-oriented
 * (008 FR-049).
 */

import { iconDescriptor, type FileIconId, type FileIconNode, type FileIconProvider, type FileIconResolution } from "./iconTypes";

/** The five fallbacks a filesystem entry may resolve to (FR-058). */
export const FILE_ICON_FALLBACKS: readonly FileIconId[] = [
  "file",
  "folder",
  "folder-open",
  "other",
  "link",
];

/**
 * The generic primary glyphs 008 paints filled (008 FR-048, SR-004).
 *
 * The *resolution* is unchanged — the same five fallbacks, chosen by the same
 * metadata — only the requested draw mode differs, and the choice stays here in
 * the provider rather than in a Tree row.
 */
const FILLED_PRIMARY_ICONS: readonly FileIconId[] = [
  "file",
  "folder",
  "folder-open",
  "other",
];

/** Resolves the primary glyph for one entry. */
function fallbackIconFor(node: FileIconNode): FileIconId {
  if (node.kind === "directory") {
    return node.expanded === true ? "folder-open" : "folder";
  }
  if (node.kind === "file") {
    return "file";
  }
  // `other` covers special and broken entries; it is displayable, never
  // expandable, and always has this fallback.
  return "other";
}

/**
 * The default provider.
 *
 * Order matters in one place only: a directory link keeps the folder glyph (its
 * kind is what the row is about) and gains the link badge, so the row never loses
 * the information that the entry can be expanded.
 */
export const defaultFileIconProvider: FileIconProvider = {
  resolve(node: FileIconNode): FileIconResolution {
    const id = fallbackIconFor(node);
    const icon = iconDescriptor(
      id,
      undefined,
      FILLED_PRIMARY_ICONS.includes(id) ? "fill" : "stroke",
    );

    if (!node.isSymlink) {
      return { icon };
    }

    // 008 FR-048/FR-050: the badge stays stroke-oriented, so it remains legible
    // on top of a filled primary glyph at 16px.
    return { icon, badge: iconDescriptor("link", "Link", "stroke") };
  },
};

/** Shorthand for the default provider. */
export function fileIcon(node: FileIconNode): FileIconResolution {
  return defaultFileIconProvider.resolve(node);
}
