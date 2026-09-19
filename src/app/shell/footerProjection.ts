/**
 * The Footer projection (007 T167, T168, T171, FR-075..FR-077).
 *
 * It derives display-only context from facts that already exist — the active
 * `WorkContext`, the active `DocumentSession` and their canonical comparison keys
 * — and mutates neither. In particular:
 *
 * - containment is decided by canonical, component-aware relation helpers, never
 *   by a lexical prefix check, so `D:\project-old` is not treated as a child of
 *   `D:\project` (FR-075);
 * - the *displayed* spelling comes from the user-facing session path, so the
 *   breadcrumb shows the casing the filesystem and the user actually use;
 * - nothing here selects or expands anything in the Explorer (FR-075).
 *
 * Pure, so every state in the Footer matrix is provable without a DOM.
 */

import type { TextFormat } from "../document/documentSession";
import { pathComponents, relativeWithinDirectory } from "../workspace/workContext";

/** The Workspace facts the Footer needs. */
export interface FooterWorkspace {
  rootPath: string;
  comparisonKey: string;
  displayName: string;
}

/** The document facts the Footer needs. */
export interface FooterDocument {
  displayName: string;
  /** User-facing path, or `null` while untitled. */
  path: string | null;
  /** Canonical path key from `pathIdentity`, or `null`. */
  pathKey: string | null;
  format: TextFormat;
}

export interface FooterProjectionInput {
  workspace: FooterWorkspace | null;
  document: FooterDocument | null;
}

/** The left-hand context the Footer shows. */
export type FooterLeftContext =
  | { kind: "empty" }
  | { kind: "workspace"; workspaceName: string; title: string }
  | { kind: "untitled"; displayName: string }
  | {
      kind: "inside";
      workspaceName: string;
      /** Path components below the Workspace root, outermost first. */
      segments: string[];
      title: string;
    }
  | { kind: "outside"; segments: string[]; title: string };

/** One read-only right-side status item. */
export interface FooterStatusItem {
  id: string;
  label: string;
  title: string;
}

export interface FooterProjection {
  left: FooterLeftContext;
  right: FooterStatusItem[];
}

/**
 * The breadcrumb segments of a path *inside* a Workspace.
 *
 * The canonical relative key establishes the relation and its depth; the
 * corresponding trailing components of the user-facing path provide the displayed
 * spelling. Taking components — not a substring — is what keeps two files whose
 * names only share a prefix apart.
 */
export function breadcrumbSegments(
  workspace: FooterWorkspace,
  document: FooterDocument,
): string[] | null {
  if (document.path === null || document.pathKey === null) {
    return null;
  }

  const relativeKey = relativeWithinDirectory(
    workspace.comparisonKey,
    document.pathKey,
  );
  if (relativeKey === null) {
    return null;
  }

  const relativeComponents = pathComponents(relativeKey);
  if (relativeComponents.length === 0) {
    // The document *is* the Workspace root: nothing below it to show.
    return [];
  }

  const displayComponents = pathComponents(document.path);
  if (displayComponents.length >= relativeComponents.length) {
    return displayComponents.slice(
      displayComponents.length - relativeComponents.length,
    );
  }
  return relativeComponents;
}

/** The read-only format items for a document. */
export function formatStatusItems(format: TextFormat): FooterStatusItem[] {
  const encoding =
    format.encoding === "utf8"
      ? format.bom === "utf8"
        ? "UTF-8 BOM"
        : "UTF-8"
      : String(format.encoding);
  const lineEnding = format.preferredLineEnding === "crlf" ? "CRLF" : "LF";

  return [
    {
      id: "encoding",
      label: encoding,
      title: `Encoding: ${encoding}`,
    },
    {
      id: "line-ending",
      label: lineEnding,
      title: `Line ending on save: ${lineEnding}`,
    },
  ];
}

/**
 * Projects the Footer's two halves.
 *
 * The right side describes the *active document only*, so it disappears cleanly
 * when nothing is active while Workspace context may remain (FR-077).
 */
export function projectFooter(input: FooterProjectionInput): FooterProjection {
  const { workspace, document } = input;

  if (document === null) {
    return {
      left:
        workspace === null
          ? { kind: "empty" }
          : {
              kind: "workspace",
              workspaceName: workspace.displayName,
              title: workspace.rootPath,
            },
      right: [],
    };
  }

  if (document.path === null) {
    return {
      left: { kind: "untitled", displayName: document.displayName },
      right: formatStatusItems(document.format),
    };
  }

  const segments =
    workspace === null ? null : breadcrumbSegments(workspace, document);

  if (workspace !== null && segments !== null) {
    return {
      left: {
        kind: "inside",
        workspaceName: workspace.displayName,
        segments,
        title: document.path,
      },
      right: formatStatusItems(document.format),
    };
  }

  // An outside file (or a document whose relation cannot be established from the
  // facts at hand) shows its own path; no Workspace is created or changed.
  return {
    left: {
      kind: "outside",
      segments: pathComponents(document.path),
      title: document.path,
    },
    right: formatStatusItems(document.format),
  };
}
