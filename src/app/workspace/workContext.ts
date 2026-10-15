/**
 * Workspace identity and path-relation primitives.
 *
 * 003 keeps one active Workspace ("WorkContext") whose identity is owned here,
 * while documents and Explorer UI state stay separate. Containment between a
 * Workspace root and a path is derived dynamically — never stored on a document
 * session — so saving or renaming a document changes its relation immediately.
 */

import type { ResolveWorkspaceRelationResult } from "../../services/workspaceFileService";

/** Process-local identity of the active Workspace. */
export type WorkContextId = string;

/**
 * The one active Workspace root.
 *
 * `comparisonKey` is the canonical identity Rust produced for the root; it is the
 * only value used to decide whether two requests name the same Workspace, so
 * equivalent spellings and links cannot create a second context.
 */
export interface WorkContext {
  /** Stable process-local id; changes on every committed replacement. */
  id: WorkContextId;
  /** Root path exactly as the user chose it; what the UI displays. */
  rootPath: string;
  /** Canonical path of the root. */
  canonicalRootPath: string;
  /** Canonical comparison identity of the root. */
  comparisonKey: string;
  /** Folder name shown in the Explorer header. */
  displayName: string;
}

/**
 * Relation of a disk-backed document to the active Workspace.
 *
 * `unbound` is an Untitled document: it has no disk path at all, so no
 * filesystem relation can be derived for it.
 */
export type WorkspaceRelation =
  | { type: "unbound" }
  | { type: "outside" }
  | { type: "inside"; relativePath: string };

/** Derives the Workspace display name from a root path. */
export function displayNameForWorkspaceRoot(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  const base = trimmed === "" ? rootPath : trimmed;
  const separatorIndex = Math.max(
    base.lastIndexOf("\\"),
    base.lastIndexOf("/"),
  );
  const name = separatorIndex === -1 ? base : base.slice(separatorIndex + 1);

  return name === "" ? rootPath : name;
}

/** Creates the next process-local Workspace identity. */
let workContextSequence = 0;
export function createWorkContextId(): WorkContextId {
  workContextSequence += 1;
  return `workspace-${workContextSequence}`;
}

/** Maps the Rust `resolve_workspace_relation` result onto the model type. */
export function toWorkspaceRelation(result: {
  type: "inside" | "outside";
  relativePath?: string;
}): WorkspaceRelation {
  if (result.type === "inside") {
    return { type: "inside", relativePath: result.relativePath ?? "" };
  }
  return { type: "outside" };
}

/** The part of the Workspace IPC service a relation derivation needs. */
export interface WorkspaceRelationSource {
  resolveWorkspaceRelation(request: {
    rootPath: string;
    targetPath: string;
  }): Promise<ResolveWorkspaceRelationResult>;
}

/**
 * Derives the relation of one disk path to one root.
 *
 * The answer comes from the Rust `resolve_workspace_relation` command, so
 * containment is canonical and component-aware: equivalent spellings, symlinks
 * and junctions resolve through the object they name, and a sibling such as
 * `D:\project-old` is never treated as being inside `D:\project`.
 *
 * A document with no disk path is `unbound` and never reaches the IPC boundary,
 * and no root at all is `outside`, which is what FR-010 needs for documents
 * opened without a Workspace.
 *
 * A *resolution failure* propagates instead of degrading to `outside`. Callers
 * act on this answer — Delete must not drop the unsaved-work warning or leave a
 * Tab open merely because containment could not be established (FR-069,
 * FR-071) — so pretending the document is outside the target is the unsafe
 * answer. Note also that the command requires a **directory** root: a file
 * target must be matched by its own canonical identity rather than asked about
 * as a root.
 */
export async function derivePathRelation(
  service: WorkspaceRelationSource,
  rootPath: string | null,
  targetPath: string | null,
): Promise<WorkspaceRelation> {
  if (targetPath === null) {
    return { type: "unbound" };
  }
  if (rootPath === null) {
    return { type: "outside" };
  }

  return toWorkspaceRelation(
    await service.resolveWorkspaceRelation({ rootPath, targetPath }),
  );
}

/**
 * Whether `targetPath` is `rootPath` itself or inside it.
 *
 * This is the frontend's containment question; it never compares path strings
 * itself (FR-043), and a resolution failure propagates so the caller can report
 * it rather than act on an unknown answer.
 */
export async function isInsideRoot(
  service: WorkspaceRelationSource,
  rootPath: string,
  targetPath: string,
): Promise<boolean> {
  return (await derivePathRelation(service, rootPath, targetPath)).type ===
    "inside";
}

/**
 * The separator a path spelling uses.
 *
 * Windows accepts both separators, and the canonical paths Rust produces always
 * use `\` there, while a user-chosen root is usually spelled with `\` as well.
 * Picking the separator from the *base* keeps a joined path consistent with the
 * spelling the user already sees.
 */
export function separatorFor(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/**
 * Splits a canonical comparison key into its components.
 *
 * Comparison keys come from Rust, so their separators and case folding already
 * follow the platform's rules. Splitting them here — instead of comparing whole
 * strings — is what makes `D:\project-old` a sibling of `D:\project` rather than
 * a child of it, and it means no `startsWith()` check is ever used for
 * containment.
 */
export function pathComponents(key: string): string[] {
  const withoutTrailing = key.replace(/[\\/]+$/, "");
  const source = withoutTrailing === "" ? key : withoutTrailing;
  return source.split(/[\\/]+/).filter((component) => component !== "");
}

/**
 * Whether `candidateKey` names `directoryKey` or something below it.
 *
 * Both sides must be canonical comparison keys, which is what the caller has:
 * the directory key comes from a directory read, and the candidate key from a
 * document's resolved path identity.
 */
export function isWithinDirectory(
  directoryKey: string,
  candidateKey: string,
): boolean {
  return relativeWithinDirectory(directoryKey, candidateKey) !== null;
}

/**
 * The part of `candidateKey` below `directoryKey`.
 *
 * Returns `null` when the candidate is not inside the directory and an empty
 * string when the two name the same object, using the separator of
 * `candidateKey` so a joined descendant path keeps the original spelling style.
 */
export function relativeWithinDirectory(
  directoryKey: string,
  candidateKey: string,
): string | null {
  const directory = pathComponents(directoryKey);
  const candidate = pathComponents(candidateKey);

  if (directory.length === 0 || candidate.length < directory.length) {
    return null;
  }

  for (const [index, component] of directory.entries()) {
    if (component !== candidate[index]) {
      return null;
    }
  }

  return candidate.slice(directory.length).join(separatorFor(candidateKey));
}

/**
 * Appends `suffix` to `base`.
 *
 * Used both with user-facing paths and with canonical comparison keys: appending
 * whole components keeps the result canonical, because per-component case
 * folding is stable under concatenation.
 */
export function joinPath(base: string, suffix: string): string {
  if (suffix === "") {
    return base;
  }
  const separator = separatorFor(base);
  const trimmed = base.replace(/[\\/]+$/, "");
  const head = trimmed === "" ? base : trimmed;
  return `${head}${separator}${suffix}`;
}
