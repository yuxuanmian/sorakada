/**
 * Unit tests for identity-aware Explorer reconciliation (006).
 *
 * `reconcileDirectorySnapshots` and `rebasePathUnder` are pure: every case here
 * is a plain fixture comparison — the nodes the Tree currently represents, one
 * authoritative one-level listing per directory, one reconciled batch out. No
 * disk, no timers, no application state.
 *
 * The identity rules these tests pin:
 *
 *   1. a surviving entry keeps its node object (cache, expansion, load state)
 *      only while the path *and* the filesystem object are unchanged, so a
 *      delete/recreate replacement at one path becomes a fresh node (FR-034);
 *   2. a proven relocation moves the same node object with its cached subtree
 *      rebased locally and leaves neither a removal behind nor an addition at
 *      the destination;
 *   3. an identity that cannot prove continuity (null, kind mismatch, ambiguous
 *      duplicates) degrades to remove + add rather than guessing;
 *   4. `removedPaths` reports "this logical node is gone", which includes a path
 *      that is now occupied by an entry the old node cannot describe.
 */

import { describe, expect, it } from "vitest";

import type {
  WorkspaceDirectoryEntry,
  WorkspaceEntryKind,
} from "../../services/workspaceFileService";
import {
  type ConfirmedExplorerRelocation,
  type DirectorySnapshot,
  type ReconciliationResult,
  type ReconciledDirectory,
  type RenameCandidate,
  rebasePathUnder,
  reconcileDirectorySnapshots,
} from "./explorerReconciliation";
import {
  type ExplorerDirectoryNode,
  type ExplorerFileNode,
  type ExplorerNode,
  type ExplorerOtherNode,
  type LoadState,
  toExplorerNode,
} from "./explorerModel";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ROOT = "C:\\work";
const SRC = "C:\\work\\src";
const VENDOR = "C:\\work\\vendor";

/** Case-insensitive path key, as the Explorer compares paths. */
function keyFor(path: string): string {
  return path.toLowerCase();
}

function leafName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** Default identity of a fixture whose token the test does not care about. */
function identityFor(path: string): string {
  return `obj:${keyFor(path)}`;
}

function file(
  path: string,
  objectIdentity: string | null = identityFor(path),
): WorkspaceDirectoryEntry {
  return {
    name: leafName(path),
    path,
    kind: "file",
    isSymlink: false,
    objectIdentity,
  };
}

function directory(
  path: string,
  objectIdentity: string | null = identityFor(path),
  isSymlink = false,
): WorkspaceDirectoryEntry {
  return {
    name: leafName(path),
    path,
    kind: "directory",
    isSymlink,
    objectIdentity,
  };
}

function other(
  path: string,
  objectIdentity: string | null = identityFor(path),
): WorkspaceDirectoryEntry {
  return {
    name: leafName(path),
    path,
    kind: "other",
    isSymlink: false,
    objectIdentity,
  };
}

function fileNode(
  path: string,
  objectIdentity: string | null = identityFor(path),
): ExplorerFileNode {
  return {
    name: leafName(path),
    path,
    kind: "file",
    isSymlink: false,
    objectIdentity,
  };
}

interface DirectoryNodeOptions {
  children?: readonly ExplorerNode[];
  expanded?: boolean;
  loadState?: LoadState;
  isSymlink?: boolean;
}

function directoryNode(
  path: string,
  objectIdentity: string | null = identityFor(path),
  options: DirectoryNodeOptions = {},
): ExplorerDirectoryNode {
  return {
    name: leafName(path),
    path,
    kind: "directory",
    isSymlink: options.isSymlink ?? false,
    objectIdentity,
    expanded: options.expanded ?? false,
    loadState: options.loadState ?? "not-loaded",
    ...(options.children === undefined ? {} : { children: options.children }),
  };
}

function otherNode(
  path: string,
  objectIdentity: string | null = identityFor(path),
): ExplorerOtherNode {
  return {
    name: leafName(path),
    path,
    kind: "other",
    isSymlink: false,
    objectIdentity,
  };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function snapshot(
  path: string,
  current: readonly ExplorerNode[],
  entries: readonly WorkspaceDirectoryEntry[],
): DirectorySnapshot {
  return { path, current, entries };
}

function reconcile(
  snapshots: readonly DirectorySnapshot[],
  renameCandidates?: readonly RenameCandidate[],
): ReconciliationResult {
  return reconcileDirectorySnapshots(
    renameCandidates === undefined ? { snapshots } : { snapshots, renameCandidates },
  );
}

function directoryResult(
  result: ReconciliationResult,
  path: string,
): ReconciledDirectory {
  const found = result.directories.find((entry) => entry.path === path);
  if (found === undefined) {
    throw new Error(`No reconciled directory for ${path}`);
  }
  return found;
}

function childAt(children: readonly ExplorerNode[], path: string): ExplorerNode | undefined {
  return children.find((child) => child.path === path);
}

function childPaths(children: readonly ExplorerNode[]): string[] {
  return children.map((child) => child.path);
}

function relocation(
  kind: WorkspaceEntryKind,
  oldPath: string,
  newPath: string,
  objectIdentity: string,
): ConfirmedExplorerRelocation {
  return { kind, oldPath, newPath, objectIdentity };
}

/* -------------------------------------------------------------------------- */
/* Unchanged entries                                                          */
/* -------------------------------------------------------------------------- */

describe("reconciliation of unchanged entries (the listing is the truth)", () => {
  it("reuses the represented node when the listing still has the path", () => {
    const src = directoryNode(SRC, "obj:src", { expanded: true, loadState: "loaded" });
    const kept = fileNode("C:\\work\\kept.ts", "obj:kept");

    const result = reconcile([
      snapshot(
        ROOT,
        [src, kept],
        [directory(SRC, "obj:src"), file("C:\\work\\kept.ts", "obj:kept")],
      ),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.addedPaths).toEqual([]);
    expect(reconciled.removedPaths).toEqual([]);
    expect(reconciled.arrivals).toEqual([]);
    expect(reconciled.departures).toEqual([]);

    // Directories first, then names case-insensitively — computed here, not
    // trusted from the listing order.
    expect(childPaths(reconciled.children)).toEqual([SRC, "C:\\work\\kept.ts"]);
    expect(childAt(reconciled.children, SRC)).toBe(src);
    expect(childAt(reconciled.children, "C:\\work\\kept.ts")).toBe(kept);

    // Load state and expansion are the node's own; the listing never owns them.
    expect(src.expanded).toBe(true);
    expect(src.loadState).toBe("loaded");
  });

  it("refreshes the listing-owned fields of a surviving node", () => {
    const link = directoryNode("C:\\work\\link", "obj:same", { isSymlink: false });

    const result = reconcile([
      snapshot(ROOT, [link], [directory("C:\\work\\link", "obj:same", true)]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(childAt(reconciled.children, "C:\\work\\link")).toBe(link);
    expect(link.objectIdentity).toBe("obj:same");
    expect(link.isSymlink).toBe(true);
    expect(reconciled.addedPaths).toEqual([]);
    expect(reconciled.removedPaths).toEqual([]);
  });

  it("returns one reconciled directory per snapshot, in snapshot order", () => {
    const src = directoryNode(SRC, "obj:src");
    const nested = fileNode("C:\\work\\src\\a.ts", "obj:a");

    const result = reconcile([
      snapshot(ROOT, [src], [directory(SRC, "obj:src")]),
      snapshot(SRC, [nested], [file("C:\\work\\src\\a.ts", "obj:a")]),
    ]);

    expect(result.directories.map((entry) => entry.path)).toEqual([ROOT, SRC]);
    expect(directoryResult(result, SRC).children).toHaveLength(1);
    expect(childAt(directoryResult(result, SRC).children, "C:\\work\\src\\a.ts")).toBe(
      nested,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Additions and removals                                                     */
/* -------------------------------------------------------------------------- */

describe("reconciliation of additions and removals", () => {
  it("reports a vanished path as removed and keeps it out of children", () => {
    const kept = fileNode("C:\\work\\kept.ts", "obj:kept");
    const gone = fileNode("C:\\work\\gone.ts", "obj:gone");

    const result = reconcile([
      snapshot(ROOT, [kept, gone], [file("C:\\work\\kept.ts", "obj:kept")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\gone.ts"]);
    expect(reconciled.addedPaths).toEqual([]);
    expect(result.relocations).toEqual([]);
    expect(childPaths(reconciled.children)).toEqual(["C:\\work\\kept.ts"]);
    expect(childAt(reconciled.children, "C:\\work\\gone.ts")).toBeUndefined();
  });

  it("reports a new path as added and gives it a fresh node", () => {
    const added = file("C:\\work\\new.ts", "obj:new");

    const result = reconcile([snapshot(ROOT, [], [added])]);

    const reconciled = directoryResult(result, ROOT);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\new.ts"]);
    expect(reconciled.removedPaths).toEqual([]);
    expect(result.relocations).toEqual([]);
    expect(childPaths(reconciled.children)).toEqual(["C:\\work\\new.ts"]);
    expect(childAt(reconciled.children, "C:\\work\\new.ts")).toEqual(
      toExplorerNode(added),
    );
  });

  it("gives an `other` entry a fresh node of its own kind", () => {
    const added = other("C:\\work\\socket", "obj:socket");

    const result = reconcile([snapshot(ROOT, [], [added])]);

    const reconciled = directoryResult(result, ROOT);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\socket"]);
    expect(childAt(reconciled.children, "C:\\work\\socket")).toEqual(
      toExplorerNode(added),
    );
    expect(childAt(reconciled.children, "C:\\work\\socket")?.kind).toBe("other");
  });
});

/* -------------------------------------------------------------------------- */
/* Same-parent rename                                                         */
/* -------------------------------------------------------------------------- */

describe("same-parent rename", () => {
  it("proves a rename from an equal non-null identity", () => {
    const node = fileNode("C:\\work\\draft.ts", "obj:1");
    const expected = relocation(
      "file",
      "C:\\work\\draft.ts",
      "C:\\work\\final.ts",
      "obj:1",
    );

    const result = reconcile([
      snapshot(ROOT, [node], [file("C:\\work\\final.ts", "obj:1")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([expected]);
    expect(reconciled.addedPaths).toEqual([]);
    expect(reconciled.removedPaths).toEqual([]);
    expect(reconciled.arrivals).toEqual([expected]);
    expect(reconciled.departures).toEqual([expected]);

    // The very same node object moved; nothing was recreated.
    expect(childAt(reconciled.children, "C:\\work\\final.ts")).toBe(node);
    expect(childPaths(reconciled.children)).toEqual(["C:\\work\\final.ts"]);
    expect(node.name).toBe("final.ts");
    expect(node.path).toBe("C:\\work\\final.ts");
  });

  it("updates the displayed casing of a case-only rename of the same object", () => {
    const node = fileNode("C:\\work\\foo.ts", "obj:1");

    const result = reconcile([
      snapshot(ROOT, [node], [file("C:\\work\\Foo.ts", "obj:1")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([
      relocation("file", "C:\\work\\foo.ts", "C:\\work\\Foo.ts", "obj:1"),
    ]);
    expect(reconciled.removedPaths).toEqual([]);
    expect(reconciled.addedPaths).toEqual([]);
    expect(childAt(reconciled.children, "C:\\work\\Foo.ts")).toBe(node);
    // FR-046: the row shows the spelling the filesystem now reports.
    expect(node.name).toBe("Foo.ts");
    expect(node.path).toBe("C:\\work\\Foo.ts");
  });

  it("moves a renamed directory with its cached subtree rebased locally", () => {
    const deep = fileNode("C:\\work\\src\\nested\\deep.ts", "obj:deep");
    const nested = directoryNode("C:\\work\\src\\nested", "obj:nested", {
      children: [deep],
      expanded: true,
      loadState: "loaded",
    });
    const src = directoryNode(SRC, "obj:src", {
      children: [nested],
      expanded: true,
      loadState: "loaded",
    });

    const result = reconcile([
      snapshot(ROOT, [src], [directory("C:\\work\\lib", "obj:src")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([
      relocation("directory", SRC, "C:\\work\\lib", "obj:src"),
    ]);
    expect(reconciled.addedPaths).toEqual([]);
    expect(reconciled.removedPaths).toEqual([]);
    expect(reconciled.children).toHaveLength(1);
    expect(reconciled.children[0]).toBe(src);

    expect(src.name).toBe("lib");
    expect(src.path).toBe("C:\\work\\lib");
    // No disk walk happens: the cached subtree is rewritten from the old prefix.
    expect(nested.path).toBe("C:\\work\\lib\\nested");
    expect(deep.path).toBe("C:\\work\\lib\\nested\\deep.ts");
    // Expansion and load state are what a rename must preserve (FR-043).
    expect(src.expanded).toBe(true);
    expect(src.loadState).toBe("loaded");
    expect(nested.expanded).toBe(true);
    expect(nested.loadState).toBe("loaded");
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-parent move                                                          */
/* -------------------------------------------------------------------------- */

interface CrossParentMove {
  result: ReconciliationResult;
  pkg: ExplorerDirectoryNode;
  nested: ExplorerDirectoryNode;
  deep: ExplorerFileNode;
  source: ReconciledDirectory;
  destination: ReconciledDirectory;
  expected: ConfirmedExplorerRelocation;
}

/** `C:\work\src\pkg` (with a loaded subtree) moved to `C:\work\vendor\pkg`. */
function movePkgToVendor(): CrossParentMove {
  const deep = fileNode("C:\\work\\src\\pkg\\nested\\deep.ts", "obj:deep");
  const nested = directoryNode("C:\\work\\src\\pkg\\nested", "obj:nested", {
    children: [deep],
    expanded: true,
    loadState: "loaded",
  });
  const pkg = directoryNode("C:\\work\\src\\pkg", "obj:pkg", {
    children: [nested],
    expanded: true,
    loadState: "loaded",
  });

  const result = reconcile([
    snapshot(SRC, [pkg], []),
    snapshot(VENDOR, [], [directory("C:\\work\\vendor\\pkg", "obj:pkg")]),
  ]);

  return {
    result,
    pkg,
    nested,
    deep,
    source: directoryResult(result, SRC),
    destination: directoryResult(result, VENDOR),
    expected: relocation("directory", "C:\\work\\src\\pkg", "C:\\work\\vendor\\pkg", "obj:pkg"),
  };
}

describe("cross-parent move", () => {
  it("proves the move inside one batch and relocates the same node object", () => {
    const { result, pkg, nested, deep, source, destination, expected } =
      movePkgToVendor();

    expect(result.relocations).toEqual([expected]);
    expect(source.departures).toEqual([expected]);
    expect(source.arrivals).toEqual([]);
    expect(destination.arrivals).toEqual([expected]);
    expect(destination.departures).toEqual([]);

    // The node leaves the source and appears in the destination, once.
    expect(source.children).toEqual([]);
    expect(childPaths(destination.children)).toEqual(["C:\\work\\vendor\\pkg"]);
    expect(destination.children[0]).toBe(pkg);
    expect(destination.addedPaths).toEqual([]);

    expect(pkg.name).toBe("pkg");
    expect(pkg.path).toBe("C:\\work\\vendor\\pkg");
    expect(pkg.kind).toBe("directory");
    expect(pkg.objectIdentity).toBe("obj:pkg");
    // The cached subtree follows the node without any directory read.
    expect(nested.path).toBe("C:\\work\\vendor\\pkg\\nested");
    expect(deep.path).toBe("C:\\work\\vendor\\pkg\\nested\\deep.ts");
    expect(pkg.expanded).toBe(true);
    expect(pkg.loadState).toBe("loaded");

    // The vacated source directory reports no removal: the node did not vanish,
    // it moved, and re-reporting its new path as removed would make the
    // interaction-state cleanup believe an unrelated path disappeared.
    expect(source.removedPaths).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Identity safety                                                            */
/* -------------------------------------------------------------------------- */

describe("identity safety", () => {
  it("does not prove continuity from a null identity", () => {
    const gone = fileNode("C:\\work\\old.ts", null);

    const result = reconcile([
      snapshot(ROOT, [gone], [file("C:\\work\\new.ts", null)]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\old.ts"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\new.ts"]);
    expect(childAt(reconciled.children, "C:\\work\\new.ts")).toEqual(
      toExplorerNode(file("C:\\work\\new.ts", null)),
    );
  });

  it("does not prove continuity when only one side has an identity", () => {
    const gone = fileNode("C:\\work\\old.ts", null);

    const result = reconcile([
      snapshot(ROOT, [gone], [file("C:\\work\\new.ts", "obj:1")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\old.ts"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\new.ts"]);
  });

  it("replaces the node when one path changes kind, even with an equal token", () => {
    const stale = fileNode("C:\\work\\thing", "obj:1");
    const replacement = directory("C:\\work\\thing", "obj:1");

    const result = reconcile([snapshot(ROOT, [stale], [replacement])]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\thing"]);
    // The path still exists, but the node that described it does not: a
    // kind change is a replacement, so the old logical node is reported gone.
    expect(reconciled.removedPaths).toEqual(["C:\\work\\thing"]);

    const fresh = childAt(reconciled.children, "C:\\work\\thing");
    expect(fresh).not.toBe(stale);
    expect(fresh).toEqual(toExplorerNode(replacement));
    expect(fresh?.kind).toBe("directory");
  });

  it("never proves continuity between incompatible kinds at different paths", () => {
    const removed = fileNode("C:\\work\\report", "obj-shared");

    const result = reconcile([
      snapshot(ROOT, [removed], [directory("C:\\work\\report-dir", "obj-shared")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\report"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\report-dir"]);
    expect(childAt(reconciled.children, "C:\\work\\report-dir")?.kind).toBe("directory");
  });

  it("never proves continuity between an `other` entry and a file", () => {
    const removed = otherNode("C:\\work\\pipe", "obj:pipe");

    const result = reconcile([
      snapshot(ROOT, [removed], [file("C:\\work\\pipe.txt", "obj:pipe")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\pipe"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\pipe.txt"]);
  });

  it("reports a removal and a fresh node when a path is recreated under a new identity", () => {
    const node = fileNode("C:\\work\\recreated.ts", "obj:old");

    const result = reconcile([
      snapshot(ROOT, [node], [file("C:\\work\\recreated.ts", "obj:new")]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    // FR-034: path equality does not prove object continuity, so a recreate is
    // a replacement — the cached node object must not inherit the new object.
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\recreated.ts"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\recreated.ts"]);
    expect(reconciled.children[0]).not.toBe(node);
    expect(reconciled.children[0].objectIdentity).toBe("obj:new");
  });

  it("never collapses several removals and additions that share one identity", () => {
    const current = [
      fileNode("C:\\work\\a.txt", "obj-shared"),
      fileNode("C:\\work\\b.txt", "obj-shared"),
    ];
    const entries = [
      file("C:\\work\\c.txt", "obj-shared"),
      file("C:\\work\\d.txt", "obj-shared"),
    ];

    const result = reconcile([snapshot(ROOT, current, entries)]);

    const reconciled = directoryResult(result, ROOT);
    // Hard-link-like duplicates prove nothing without an explicit pair.
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\b.txt",
    ]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\c.txt", "C:\\work\\d.txt"]);
    expect(childPaths(reconciled.children)).toEqual([
      "C:\\work\\c.txt",
      "C:\\work\\d.txt",
    ]);
  });

  it("never collapses several additions that share one identity", () => {
    const result = reconcile([
      snapshot(
        ROOT,
        [],
        [file("C:\\work\\c.txt", "obj-shared"), file("C:\\work\\d.txt", "obj-shared")],
      ),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\c.txt", "C:\\work\\d.txt"]);
    expect(reconciled.children).toHaveLength(2);
  });

  it("narrows an ambiguous identity group with paired rename candidates", () => {
    const a = fileNode("C:\\work\\a.txt", "obj-shared");
    const b = fileNode("C:\\work\\b.txt", "obj-shared");

    const result = reconcile(
      [
        snapshot(ROOT, [a, b], [
          file("C:\\work\\c.txt", "obj-shared"),
          file("C:\\work\\d.txt", "obj-shared"),
        ]),
      ],
      [
        { sourcePath: "C:\\work\\a.txt", targetPath: "C:\\work\\c.txt" },
        { sourcePath: "C:\\work\\b.txt", targetPath: "C:\\work\\d.txt" },
      ],
    );

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([
      relocation("file", "C:\\work\\a.txt", "C:\\work\\c.txt", "obj-shared"),
      relocation("file", "C:\\work\\b.txt", "C:\\work\\d.txt", "obj-shared"),
    ]);
    expect(reconciled.removedPaths).toEqual([]);
    expect(reconciled.addedPaths).toEqual([]);
    expect(childAt(reconciled.children, "C:\\work\\c.txt")).toBe(a);
    expect(childAt(reconciled.children, "C:\\work\\d.txt")).toBe(b);
  });

  it("relocates only the narrowed pair when one hint is given", () => {
    const a = fileNode("C:\\work\\a.txt", "obj-shared");
    const b = fileNode("C:\\work\\b.txt", "obj-shared");

    const result = reconcile(
      [
        snapshot(ROOT, [a, b], [
          file("C:\\work\\c.txt", "obj-shared"),
          file("C:\\work\\d.txt", "obj-shared"),
        ]),
      ],
      [{ sourcePath: "C:\\work\\a.txt", targetPath: "C:\\work\\c.txt" }],
    );

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([
      relocation("file", "C:\\work\\a.txt", "C:\\work\\c.txt", "obj-shared"),
    ]);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\b.txt"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\d.txt"]);
    expect(childAt(reconciled.children, "C:\\work\\c.txt")).toBe(a);
  });

  it("ignores a hint whose token does not confirm the pair", () => {
    const a = fileNode("C:\\work\\a.txt", "obj-shared");
    const b = fileNode("C:\\work\\b.txt", "obj-shared");

    const result = reconcile(
      [
        snapshot(ROOT, [a, b], [
          file("C:\\work\\c.txt", "obj-shared"),
          file("C:\\work\\e.txt", "obj-else"),
        ]),
      ],
      [{ sourcePath: "C:\\work\\a.txt", targetPath: "C:\\work\\e.txt" }],
    );

    const reconciled = directoryResult(result, ROOT);
    // The hint may only narrow the group; it is never proof on its own (FR-040).
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\b.txt",
    ]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\c.txt", "C:\\work\\e.txt"]);
  });

  it("ignores a hint with no target path", () => {
    const a = fileNode("C:\\work\\a.txt", "obj-shared");
    const b = fileNode("C:\\work\\b.txt", "obj-shared");

    const result = reconcile(
      [
        snapshot(ROOT, [a, b], [
          file("C:\\work\\c.txt", "obj-shared"),
          file("C:\\work\\d.txt", "obj-shared"),
        ]),
      ],
      [{ sourcePath: "C:\\work\\b.txt", targetPath: null }],
    );

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\b.txt",
    ]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\c.txt", "C:\\work\\d.txt"]);
  });

  it("keeps two logical entries that reach one object apart", () => {
    const linkA = directoryNode("C:\\work\\link-a", "obj-shared", { isSymlink: true });
    const linkB = directoryNode("C:\\work\\link-b", "obj-shared", { isSymlink: true });

    const result = reconcile([
      snapshot(ROOT, [linkA, linkB], [
        directory("C:\\work\\link-a", "obj-shared", true),
        directory("C:\\work\\link-b", "obj-shared", true),
      ]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    // Identity never deduplicates Tree positions (FR-047, FR-090).
    expect(result.relocations).toEqual([]);
    expect(reconciled.addedPaths).toEqual([]);
    expect(reconciled.removedPaths).toEqual([]);
    expect(childPaths(reconciled.children)).toEqual([
      "C:\\work\\link-a",
      "C:\\work\\link-b",
    ]);
    expect(childAt(reconciled.children, "C:\\work\\link-a")).toBe(linkA);
    expect(childAt(reconciled.children, "C:\\work\\link-b")).toBe(linkB);
  });

  it("carries no identity matching from one call to the next", () => {
    const first = reconcile([
      snapshot(ROOT, [fileNode("C:\\work\\foo.ts", "obj:1")], [
        file("C:\\work\\Foo.ts", "obj:1"),
      ]),
    ]);
    expect(first.relocations).toEqual([
      relocation("file", "C:\\work\\foo.ts", "C:\\work\\Foo.ts", "obj:1"),
    ]);

    // The identical batch re-run is deterministic...
    const repeated = reconcile([
      snapshot(ROOT, [fileNode("C:\\work\\foo.ts", "obj:1")], [
        file("C:\\work\\Foo.ts", "obj:1"),
      ]),
    ]);
    expect(repeated.relocations).toEqual(first.relocations);

    // ...and a later batch that only sees the removal knows nothing about it.
    const removalOnly = reconcile([
      snapshot(ROOT, [fileNode("C:\\work\\Foo.ts", "obj:1")], []),
    ]);
    expect(removalOnly.relocations).toEqual([]);
    expect(directoryResult(removalOnly, ROOT).removedPaths).toEqual([
      "C:\\work\\Foo.ts",
    ]);

    const additionOnly = reconcile([
      snapshot(ROOT, [], [file("C:\\work\\Foo.ts", "obj:1")]),
    ]);
    expect(additionOnly.relocations).toEqual([]);
    expect(directoryResult(additionOnly, ROOT).addedPaths).toEqual([
      "C:\\work\\Foo.ts",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* rebasePathUnder                                                            */
/* -------------------------------------------------------------------------- */

describe("rebasePathUnder", () => {
  it("rebases the relocated path itself", () => {
    expect(rebasePathUnder(SRC, "C:\\work\\lib", SRC)).toBe("C:\\work\\lib");
    expect(
      rebasePathUnder("C:\\work\\draft.ts", "C:\\work\\final.ts", "C:\\work\\draft.ts"),
    ).toBe("C:\\work\\final.ts");
  });

  it("rebases a descendant of the relocated directory", () => {
    expect(rebasePathUnder(SRC, "C:\\work\\lib", "C:\\work\\src\\a.ts")).toBe(
      "C:\\work\\lib\\a.ts",
    );
    expect(
      rebasePathUnder(SRC, "C:\\work\\lib", "C:\\work\\src\\nested\\deep.ts"),
    ).toBe("C:\\work\\lib\\nested\\deep.ts");
  });

  it("leaves a prefix sibling alone", () => {
    // `src2` only shares a name prefix with `src`; containment is per component.
    expect(rebasePathUnder(SRC, "C:\\work\\lib", "C:\\work\\src2")).toBeNull();
    expect(rebasePathUnder(SRC, "C:\\work\\lib", "C:\\work\\src2\\c.ts")).toBeNull();
    expect(
      rebasePathUnder("C:\\work\\draft.ts", "C:\\work\\final.ts", "C:\\work\\draft.ts.bak"),
    ).toBeNull();
  });

  it("leaves an unrelated path alone", () => {
    expect(rebasePathUnder(SRC, "C:\\work\\lib", "C:\\work\\other\\c.ts")).toBeNull();
    expect(rebasePathUnder(SRC, "C:\\work\\lib", ROOT)).toBeNull();
    expect(rebasePathUnder(SRC, "C:\\work\\lib", "D:\\elsewhere\\src\\a.ts")).toBeNull();
  });

  it("rebases a deeper descendant of a renamed directory", () => {
    const oldPath = "C:\\work\\src\\nested";
    const newPath = "C:\\work\\src\\renamed";

    expect(rebasePathUnder(oldPath, newPath, oldPath)).toBe(newPath);
    expect(rebasePathUnder(oldPath, newPath, "C:\\work\\src\\nested\\a\\b.ts")).toBe(
      "C:\\work\\src\\renamed\\a\\b.ts",
    );
    // The renamed directory's own siblings are untouched.
    expect(rebasePathUnder(oldPath, newPath, "C:\\work\\src\\nested2\\a.ts")).toBeNull();
    expect(rebasePathUnder(oldPath, newPath, SRC)).toBeNull();
  });

  it("compares canonical components exactly", () => {
    // Both sides are canonical comparison keys, which Rust has already
    // case-folded, so the helper itself only has to split on separators.
    expect(rebasePathUnder(SRC, "C:\\work\\lib", "C:\\work\\SRC\\a.ts")).toBeNull();
    // The joined suffix follows the separator spelling of the new path.
    expect(rebasePathUnder(SRC, "C:/work/lib", "C:/work/src/a.ts")).toBe(
      "C:/work/lib/a.ts",
    );
  });
});

describe("sequential external renames (FR-053)", () => {
  it("converges to the current provable location without persisting a history", () => {
    // a -> b -> c, each step observed as its own batch. Only the current
    // filesystem state matters; the intermediate name must not survive as any
    // kind of rename history.
    const node = fileNode("C:\\work\\a.txt", "obj:1");

    const first = reconcile([
      snapshot(ROOT, [node], [file("C:\\work\\b.txt", "obj:1")]),
    ]);
    const second = reconcile([
      snapshot(ROOT, first.directories[0].children, [
        file("C:\\work\\c.txt", "obj:1"),
      ]),
    ]);

    expect(first.relocations).toEqual([
      relocation("file", "C:\\work\\a.txt", "C:\\work\\b.txt", "obj:1"),
    ]);
    expect(second.relocations).toEqual([
      relocation("file", "C:\\work\\b.txt", "C:\\work\\c.txt", "obj:1"),
    ]);

    const reconciled = second.directories[0];
    expect(childPaths(reconciled.children)).toEqual(["C:\\work\\c.txt"]);
    // The same logical node followed both steps, and nothing remembers "a" or
    // "b" any more.
    expect(reconciled.children[0]).toBe(node);
    expect(node.path).toBe("C:\\work\\c.txt");
    expect(reconciled.removedPaths).toEqual([]);
    expect(reconciled.addedPaths).toEqual([]);
  });
});

describe("reconciliation without object identity (FR-034, FR-042)", () => {
  it("treats a same-path entry with no identity on either side as a replacement", () => {
    const node = fileNode("C:\\work\\thing.ts", null);

    const result = reconcile([
      snapshot(ROOT, [node], [file("C:\\work\\thing.ts", null)]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    // No proof of continuity => remove + create, so a delete/recreate at one path
    // can never inherit the old node's cached state by accident.
    expect(result.relocations).toEqual([]);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\thing.ts"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\thing.ts"]);
    expect(reconciled.children).toHaveLength(1);
    expect(reconciled.children[0]).not.toBe(node);
  });

  it("treats a one-sided identity as a replacement as well", () => {
    const known = fileNode("C:\\work\\known.ts", "obj:1");
    const unknown = fileNode("C:\\work\\unknown.ts", null);

    const result = reconcile([
      snapshot(ROOT, [known, unknown], [
        file("C:\\work\\known.ts", "obj:1"),
        file("C:\\work\\unknown.ts", "obj:2"),
      ]),
    ]);

    const reconciled = directoryResult(result, ROOT);
    expect(result.relocations).toEqual([]);
    // The provable entry survives in place; the unprovable one is replaced.
    expect(childAt(reconciled.children, "C:\\work\\known.ts")).toBe(known);
    expect(reconciled.removedPaths).toEqual(["C:\\work\\unknown.ts"]);
    expect(reconciled.addedPaths).toEqual(["C:\\work\\unknown.ts"]);
    expect(childAt(reconciled.children, "C:\\work\\unknown.ts")).not.toBe(unknown);
  });
});
