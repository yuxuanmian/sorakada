/**
 * The Sorakada icon contracts (007 T026, FR-056..FR-058).
 *
 * 007 splits icon *semantics* from icon *rendering*:
 *
 * - `UiIconProvider` answers "which glyph does this shell action use?";
 * - `FileIconProvider` answers "which glyph does this filesystem entry use?".
 *
 * Both answer with a provider-neutral `IconDescriptor` — a stable id plus an
 * optional accessible label — so Explorer rows never contain an extension or
 * filename branch (FR-057) and a later icon library or icon theme can replace the
 * providers without touching a component (FR-059).
 *
 * Nothing in these contracts can read a file: the metadata handed to a provider
 * is exactly what the already-materialized Tree node carries (FR-060).
 */

import type { WorkspaceEntryKind } from "../../services/workspaceFileService";

/**
 * The glyph vocabulary the shell and the Explorer need today.
 *
 * It is a Sorakada vocabulary, not a library's: an icon theme maps these ids onto
 * its own artwork.
 */
export type UiIconId =
  | "chevron-right"
  | "chevron-down"
  | "new-file"
  | "new-folder"
  | "refresh"
  | "rename"
  | "delete"
  | "plus"
  | "close"
  | "minimize"
  | "maximize"
  | "restore"
  | "locate"
  | "collapse-all"
  | "more"
  | "filter"
  | "list";

/**
 * The fallback glyphs a filesystem entry may resolve to.
 *
 * 007 deliberately ships no language or special-file mappings (FR-058), so this
 * closed set is what `FileIconProvider` returns.
 */
export type FileIconId = "file" | "folder" | "folder-open" | "other" | "link";

/** Every id the default renderer knows how to draw. */
export type IconId = UiIconId | FileIconId;

/** A provider's answer: which glyph, and how to announce it. */
export interface IconDescriptor {
  /** The provider-neutral glyph id. */
  id: IconId;
  /**
   * Accessible label.
   *
   * Omitted means "decorative": a row icon is hidden from assistive technology
   * because the row text already names the entry.
   */
  title?: string;
}

/** Builds a descriptor, keeping the optional label optional. */
export function iconDescriptor(id: IconId, title?: string): IconDescriptor {
  return title === undefined ? { id } : { id, title };
}

/** Resolves the icon for one shell/application action. */
export interface UiIconProvider {
  resolve(id: UiIconId, title?: string): IconDescriptor;
}

/**
 * The metadata a filesystem icon may be resolved from.
 *
 * It mirrors what a materialized `ExplorerNode` already holds. `path` is optional
 * and exists only so a future provider *could* match on more than the leaf name —
 * no 007 provider reads it, and no provider may read a file (FR-060).
 */
export interface FileIconNode {
  /** Final path component, exactly as the filesystem spells it. */
  name: string;
  /** What the entry is. */
  kind: WorkspaceEntryKind;
  /** Whether the entry is itself a link/reparse point. */
  isSymlink: boolean;
  /** Whether a directory row is currently expanded; ignored for files. */
  expanded?: boolean;
  /** User-facing path, for providers that need more than the leaf name. */
  path?: string;
}

/** A filesystem icon plus its optional secondary marker. */
export interface FileIconResolution {
  /** The primary glyph. */
  icon: IconDescriptor;
  /**
   * A secondary marker, if the entry has one.
   *
   * 007 marks links this way, which is what keeps "is this a link?" a
   * provider-owned decision instead of a branch inside the Tree row.
   */
  badge?: IconDescriptor;
}

/** Resolves the icon for one filesystem entry. */
export interface FileIconProvider {
  resolve(node: FileIconNode): FileIconResolution;
}
