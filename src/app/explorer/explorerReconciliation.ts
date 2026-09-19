/**
 * Pure identity-aware Explorer reconciliation (006).
 *
 * Reconciliation answers one question: *given what the Tree currently
 * represents and a fresh authoritative one-level listing, what should the Tree
 * represent now?* The answer is computed here, with no filesystem access, no
 * timers and no mutable application state, so the rename/move rules are
 * deterministic and testable in isolation.
 *
 * Three rules shape everything below:
 *
 * 1. **The listing is the truth** (FR-014). Additions and removals come from the
 *    fresh direct children, never from an event sequence.
 * 2. **Continuity needs proof** (FR-039–FR-042). A removed entry and an added
 *    entry are the same logical node only when they share the same non-null
 *    filesystem-object identity *and* a compatible kind. Name, size, timestamp,
 *    content similarity and event adjacency are never evidence — a paired rename
 *    hint may only *narrow* which candidates are considered, never prove them.
 * 3. **Identity never becomes a Tree key** (FR-047, FR-090). Two logical
 *    positions may reach one physical object (symlinks, junctions, hard links),
 *    so identity never deduplicates nodes, and an ambiguous identity group is
 *    left as remove+add unless an explicit source/target pair narrows it.
 *
 * Node records are plain mutable records by design (see `explorerModel`), so a
 * surviving node is reused — and its cached subtree rebased — rather than
 * replaced, which is what preserves expansion, cached grandchildren and
 * selection across a confirmed relocation (FR-043, FR-044).
 */

import type {
  WorkspaceDirectoryEntry,
  WorkspaceEntryKind,
} from "../../services/workspaceFileService";
import { isWithinDirectory, joinPath, relativeWithinDirectory } from "../workspace/workContext";
import {
  rebaseNodePaths,
  sortExplorerEntries,
  toExplorerNode,
  type ExplorerNode,
} from "./explorerModel";

/**
 * One represented directory's current children plus its fresh listing.
 *
 * A reconciliation call may carry several of these, which is what makes a
 * cross-parent move provable: the source parent's removal and the destination
 * parent's addition are matched inside the same batch, not against any
 * remembered history.
 */
export interface DirectorySnapshot {
  /** Logical path of the represented directory. */
  path: string;
  /** The children the Tree currently represents for it. */
  current: readonly ExplorerNode[];
  /** The authoritative direct children read from disk. */
  entries: readonly WorkspaceDirectoryEntry[];
}

/**
 * A paired rename source/target hint from the watcher.
 *
 * It can only *narrow* an ambiguous identity group to one exact logical pair; it
 * is never proof on its own (FR-040).
 */
export interface RenameCandidate {
  sourcePath: string;
  targetPath: string | null;
}

/** A relocation proven inside one reconciliation batch. */
export interface ConfirmedExplorerRelocation {
  /** What the relocated entry is; source and destination agree on this. */
  kind: WorkspaceEntryKind;
  /** The logical path the node had. */
  oldPath: string;
  /** The logical path it now has. */
  newPath: string;
  /** The filesystem-object identity that proved the continuity. */
  objectIdentity: string;
}

/** One directory's reconciled result. */
export interface ReconciledDirectory {
  /** Logical path of the directory. */
  path: string;
  /** The children to represent, sorted; surviving nodes are reused. */
  children: ExplorerNode[];
  /** Paths that appeared with no proven continuity (fresh nodes). */
  addedPaths: string[];
  /** Paths that disappeared with no proven continuity. */
  removedPaths: string[];
  /** Proven relocations whose destination is one of this directory's children. */
  arrivals: ConfirmedExplorerRelocation[];
  /** Proven relocations that left this directory. */
  departures: ConfirmedExplorerRelocation[];
}

/** The whole batch's result. */
export interface ReconciliationResult {
  directories: ReconciledDirectory[];
  /** Every relocation proven in this batch, in a stable order. */
  relocations: ConfirmedExplorerRelocation[];
}

export interface ReconciliationRequest {
  snapshots: readonly DirectorySnapshot[];
  /** Paired source/target hints used only to narrow ambiguous candidates. */
  renameCandidates?: readonly RenameCandidate[];
}

/** One removed logical entry: it is represented but not on disk any more. */
interface Removal {
  directoryPath: string;
  path: string;
  node: ExplorerNode;
  identity: string | null;
}

/** One added entry: it is on disk but not represented at that path. */
interface Addition {
  directoryPath: string;
  path: string;
  entry: WorkspaceDirectoryEntry;
  identity: string | null;
}

/** Groups items by a key, preserving insertion order. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

/** Whether a node's kind can describe a fresh listing entry's kind. */
function kindsAreCompatible(left: ExplorerNode, right: WorkspaceEntryKind): boolean {
  return left.kind === right;
}

/**
 * Whether a path still holds the *same* filesystem object.
 *
 * Continuity requires affirmative proof: equal, non-null tokens on both sides.
 * A missing token on either side means the object cannot be identified, and the
 * frozen contract forbids treating path equality as proof — a delete/recreate
 * replacement at the same logical path would otherwise inherit the old node, its
 * cached children and its interaction state (FR-034, FR-042). Such an entry is
 * reported as a replacement instead, so the Tree shows exactly what the listing
 * says.
 */
function identityContinuity(
  represented: string | null,
  listed: string | null,
): boolean {
  if (represented === null || listed === null) {
    return false;
  }
  return represented === listed;
}

/**
 * Reconciles one batch of directory listings against the represented Tree.
 *
 * The returned node arrays are the ones the Tree should hold. Surviving nodes
 * keep their identity, cached children, expansion and load state; relocated
 * nodes are the *same* node objects moved to their new path with their cached
 * subtree rebased; everything else is a fresh node.
 */
export function reconcileDirectorySnapshots(
  request: ReconciliationRequest,
): ReconciliationResult {
  const renameCandidates = request.renameCandidates ?? [];

  const removals: Removal[] = [];
  const additions: Addition[] = [];
  const listedByDirectory = new Map<string, Map<string, WorkspaceDirectoryEntry>>();
  const representedByDirectory = new Map<string, Map<string, ExplorerNode>>();

  for (const snapshot of request.snapshots) {
    const listed = new Map<string, WorkspaceDirectoryEntry>();
    for (const entry of snapshot.entries) {
      listed.set(entry.path, entry);
    }
    listedByDirectory.set(snapshot.path, listed);

    const represented = new Map<string, ExplorerNode>();
    for (const child of snapshot.current) {
      represented.set(child.path, child);
    }
    representedByDirectory.set(snapshot.path, represented);

    for (const [path, node] of represented) {
      const entry = listed.get(path);
      if (entry !== undefined && kindsAreCompatible(node, entry.kind)) {
        // Unchanged path with a compatible kind: the node stays where it is.
        continue;
      }
      removals.push({
        directoryPath: snapshot.path,
        path,
        node,
        identity: node.objectIdentity,
      });
    }

    for (const [path, entry] of listed) {
      const node = represented.get(path);
      if (node !== undefined && kindsAreCompatible(node, entry.kind)) {
        continue;
      }
      additions.push({
        directoryPath: snapshot.path,
        path,
        entry,
        identity: entry.objectIdentity,
      });
    }
  }

  /** The candidate key of one directory + path pair. */
  const keyOf = (directoryPath: string, path: string): string =>
    `${directoryPath}\u0000${path}`;

  const removalByKey = new Map<string, Removal>();
  for (const removal of removals) {
    removalByKey.set(keyOf(removal.directoryPath, removal.path), removal);
  }
  const additionByKey = new Map<string, Addition>();
  for (const addition of additions) {
    additionByKey.set(keyOf(addition.directoryPath, addition.path), addition);
  }

  const relocations: ConfirmedExplorerRelocation[] = [];
  const relocatedRemovals = new Set<Removal>();
  const relocatedAdditions = new Set<Addition>();
  /** The proven pairs themselves, so the node move never has to be re-derived. */
  const provenPairs: Array<{ removal: Removal; addition: Addition }> = [];

  /** Claims one proven pair, if both ends are still unclaimed and compatible. */
  const claim = (removal: Removal, addition: Addition): boolean => {
    if (relocatedRemovals.has(removal) || relocatedAdditions.has(addition)) {
      return false;
    }
    if (removal.identity === null || removal.identity !== addition.identity) {
      return false;
    }
    if (!kindsAreCompatible(removal.node, addition.entry.kind)) {
      return false;
    }

    relocatedRemovals.add(removal);
    relocatedAdditions.add(addition);
    provenPairs.push({ removal, addition });
    relocations.push({
      kind: addition.entry.kind,
      oldPath: removal.path,
      newPath: addition.path,
      objectIdentity: addition.identity,
    });
    return true;
  };

  const removalsByIdentity = groupBy(
    removals.filter((removal) => removal.identity !== null),
    (removal) => removal.identity as string,
  );
  const additionsByIdentity = groupBy(
    additions.filter((addition) => addition.identity !== null),
    (addition) => addition.identity as string,
  );

  // Identities are processed in first-seen order so a batch is deterministic.
  for (const [identity, identityRemovals] of removalsByIdentity) {
    const identityAdditions = additionsByIdentity.get(identity) ?? [];
    if (identityAdditions.length === 0) {
      continue;
    }

    if (identityRemovals.length === 1 && identityAdditions.length === 1) {
      // One removal and one addition sharing a non-null identity inside this
      // batch: the same object provably moved, whatever the paths look like.
      // This is also what makes a case-only rename (`foo.ts` -> `Foo.ts`)
      // continuous, because the paths differ while the object does not.
      claim(identityRemovals[0], identityAdditions[0]);
      continue;
    }

    // Ambiguous group: several logical entries share one physical object (hard
    // links) or one entry appears twice. Identity alone MUST NOT collapse them,
    // so only an explicit paired source/target hint may narrow an exact pair —
    // and the identity still has to confirm it (FR-040, FR-090).
    for (const candidate of renameCandidates) {
      if (candidate.targetPath === null) {
        continue;
      }
      const source = identityRemovals.find(
        (removal) => removal.path === candidate.sourcePath,
      );
      const target = identityAdditions.find(
        (addition) => addition.path === candidate.targetPath,
      );
      if (source !== undefined && target !== undefined) {
        claim(source, target);
      }
    }
  }

  /** The relocated node object for one destination path. */
  const arrivals = new Map<string, ExplorerNode>();
  /** The node objects that provably moved, so no removal loop re-reports them. */
  const relocatedNodes = new Set<ExplorerNode>();
  for (const { removal, addition } of provenPairs) {
    // The node moves with its cached subtree; only names and paths change. No
    // disk walk happens here: descendants are rebased locally (FR-044, FR-045).
    rebaseNodePaths(removal.node, removal.path, addition.path);
    removal.node.name = addition.entry.name;
    removal.node.isSymlink = addition.entry.isSymlink;
    removal.node.objectIdentity = addition.entry.objectIdentity;
    relocatedNodes.add(removal.node);
    arrivals.set(keyOf(addition.directoryPath, addition.path), removal.node);
  }

  const additionIsRelocated = (addition: Addition): boolean =>
    relocatedAdditions.has(addition);

  const directories = request.snapshots.map((snapshot) => {
    const represented =
      representedByDirectory.get(snapshot.path) ?? new Map<string, ExplorerNode>();
    const children: ExplorerNode[] = [];
    const addedPaths: string[] = [];
    /** The node objects that survived in place, so removal never re-reports one. */
    const surviving = new Set<ExplorerNode>();

    for (const entry of snapshot.entries) {
      const arrival = arrivals.get(keyOf(snapshot.path, entry.path));
      if (arrival !== undefined && arrival.kind === entry.kind) {
        children.push(arrival);
        continue;
      }

      const existing = represented.get(entry.path);
      if (
        existing !== undefined &&
        kindsAreCompatible(existing, entry.kind) &&
        identityContinuity(existing.objectIdentity, entry.objectIdentity)
      ) {
        // A surviving entry keeps its node object, its cached grandchildren, its
        // expansion and its load state; only the fields the listing owns are
        // refreshed. The name assignment is what makes a case-only rename show
        // the on-disk casing (FR-046).
        //
        // The same path only proves continuity when the object did not change:
        // a delete/recreate replacement at one path is a *different* filesystem
        // object, so it becomes a fresh node instead of inheriting the old one's
        // cache (FR-034).
        existing.name = entry.name;
        existing.isSymlink = entry.isSymlink;
        existing.objectIdentity = entry.objectIdentity;
        surviving.add(existing);
        children.push(existing);
        continue;
      }

      const addition = additionByKey.get(keyOf(snapshot.path, entry.path));
      if (addition !== undefined && additionIsRelocated(addition)) {
        // A proven relocation whose arrival could not be placed (defensive): one
        // proven object must never produce a second node.
        continue;
      }

      addedPaths.push(entry.path);
      children.push(toExplorerNode(entry));
    }

    const removedPaths: string[] = [];
    for (const child of snapshot.current) {
      if (surviving.has(child) || relocatedNodes.has(child)) {
        continue;
      }
      // Either the entry is gone, or the path is now occupied by an entry this
      // node cannot describe (a kind change or a replacement object). Both are
      // "this logical node is gone", which is what selection and an inline edit
      // have to react to (FR-086, FR-087).
      removedPaths.push(child.path);
    }

    return {
      path: snapshot.path,
      children: sortExplorerEntries(children),
      addedPaths,
      removedPaths,
      arrivals: relocations.filter(
        (relocation) => parentDirectoryOf(relocation.newPath) === snapshot.path,
      ),
      departures: relocations.filter(
        (relocation) => parentDirectoryOf(relocation.oldPath) === snapshot.path,
      ),
    };
  });

  return { directories, relocations };
}

/**
 * The parent of a logical path.
 *
 * The Tree builds entry paths by joining a directory path with a leaf name, so
 * the last component can be removed exactly, without asking the filesystem.
 */
export function parentDirectoryOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) {
    return trimmed;
  }

  const parent = trimmed.slice(0, index);
  // A drive root keeps its separator: `C:` alone is drive-relative.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/**
 * The path `candidate` has after `oldPath` was relocated to `newPath`.
 *
 * Returns `null` when the candidate is unaffected — it is neither the relocated
 * entry nor inside it. Containment is decided per path component, so relocating
 * `src` never rebases a path in the prefix sibling `src2` (FR-043).
 *
 * This is pure and disk-free on purpose: a confirmed directory relocation must
 * rebase the cached subtree, the selection and an in-flight inline edit without
 * walking the directory (FR-044).
 */
export function rebasePathUnder(
  oldPath: string,
  newPath: string,
  candidate: string,
): string | null {
  if (!isWithinDirectory(oldPath, candidate)) {
    return null;
  }

  const suffix = relativeWithinDirectory(oldPath, candidate);
  if (suffix === null) {
    return null;
  }

  return joinPath(newPath, suffix);
}
