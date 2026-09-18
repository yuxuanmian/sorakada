import { describe, expect, it } from "vitest";

import type { FileCommandError } from "../../services/fileService";
import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import type { WorkContext } from "../workspace/workContext";
import { displayNameForWorkspaceRoot } from "../workspace/workContext";
import { ExplorerController } from "./explorerController";
import {
  DIRECTORY_CYCLE_MESSAGE,
  type ExplorerDirectoryNode,
  type ExplorerState,
} from "./explorerModel";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

interface DirectoryFixture {
  entries: WorkspaceDirectoryEntry[];
  /** Canonical target the read reports; defaults to the requested path. */
  canonicalPath?: string;
  comparisonKey?: string;
}

/**
 * Stands in for the Rust-backed Workspace service.
 *
 * Reads are recorded, can be held open to observe in-flight behaviour, and can
 * report a canonical target that differs from the requested path, which is how
 * a symlink/junction cycle is reproduced without touching a disk.
 */
class FakeReader {
  readonly reads: string[] = [];

  private readonly directories = new Map<string, DirectoryFixture>();
  private readonly failures = new Map<string, FileCommandError>();

  hold = false;

  private held: Array<{
    path: string;
    outcome: ReadOutcome;
    resolve: (result: ReadWorkspaceDirectoryResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  addDirectory(path: string, fixture: Partial<DirectoryFixture> = {}): void {
    this.directories.set(keyFor(path), {
      entries: fixture.entries ?? [],
      ...(fixture.canonicalPath === undefined
        ? {}
        : { canonicalPath: fixture.canonicalPath }),
      ...(fixture.comparisonKey === undefined
        ? {}
        : { comparisonKey: fixture.comparisonKey }),
    });
  }

  failWith(path: string, error: FileCommandError): void {
    this.failures.set(keyFor(path), error);
  }

  /** Makes a previously failing path readable again. */
  clearFailure(path: string): void {
    this.failures.delete(keyFor(path));
  }

  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult> {
    this.reads.push(path);

    // The outcome is captured when the read is issued, exactly as a real
    // directory listing describes the disk at read time.
    const outcome = this.outcomeFor(path);

    if (this.hold) {
      return new Promise<ReadWorkspaceDirectoryResult>((resolve, reject) => {
        this.held.push({ path, outcome, resolve, reject });
      });
    }

    return new Promise<ReadWorkspaceDirectoryResult>((resolve, reject) => {
      settleOutcome(outcome, resolve, reject);
    });
  }

  releaseNext(): void {
    const entry = this.held.shift();
    if (entry !== undefined) {
      settleOutcome(entry.outcome, entry.resolve, entry.reject);
    }
  }

  /** Completes the newest held read first, to model out-of-order completion. */
  releaseLast(): void {
    const entry = this.held.pop();
    if (entry !== undefined) {
      settleOutcome(entry.outcome, entry.resolve, entry.reject);
    }
  }

  releaseAll(): void {
    const held = this.held;
    this.held = [];
    for (const entry of held) {
      settleOutcome(entry.outcome, entry.resolve, entry.reject);
    }
  }

  pendingReadCount(): number {
    return this.held.length;
  }

  readsFor(path: string): number {
    return this.reads.filter((read) => keyFor(read) === keyFor(path)).length;
  }

  private outcomeFor(path: string): ReadOutcome {
    const failure = this.failures.get(keyFor(path));
    if (failure !== undefined) {
      return { type: "error", error: failure };
    }

    const fixture = this.directories.get(keyFor(path));
    if (fixture === undefined) {
      return {
        type: "error",
        error: {
          code: "io_directory",
          message: `Cannot read directory ${path}`,
        },
      };
    }

    const canonicalPath = fixture.canonicalPath ?? path;
    return {
      type: "ok",
      result: {
        requestedPath: path,
        canonicalPath,
        comparisonKey: fixture.comparisonKey ?? keyFor(canonicalPath),
        entries: fixture.entries,
      },
    };
  }
}

/** A read outcome captured when the read was issued. */
type ReadOutcome =
  | { type: "ok"; result: ReadWorkspaceDirectoryResult }
  | { type: "error"; error: FileCommandError };

function settleOutcome(
  outcome: ReadOutcome,
  resolve: (result: ReadWorkspaceDirectoryResult) => void,
  reject: (error: unknown) => void,
): void {
  if (outcome.type === "ok") {
    resolve(outcome.result);
    return;
  }
  reject(outcome.error);
}

function keyFor(path: string): string {
  return path.toLowerCase();
}

function file(path: string): WorkspaceDirectoryEntry {
  return { name: leafName(path), path, kind: "file", isSymlink: false };
}

function directory(path: string, isSymlink = false): WorkspaceDirectoryEntry {
  return { name: leafName(path), path, kind: "directory", isSymlink };
}

function leafName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

interface Harness {
  controller: ExplorerController;
  reader: FakeReader;
  states: ExplorerState[];
  rootUnavailable: boolean[];
}

function createHarness(): Harness {
  const reader = new FakeReader();
  const states: ExplorerState[] = [];
  const rootUnavailable: boolean[] = [];

  const controller = new ExplorerController({
    workspaceFileService: reader,
    onRootUnavailable: (unavailable) => {
      rootUnavailable.push(unavailable);
    },
  });
  controller.subscribe((state) => {
    states.push(state);
  });

  return { controller, reader, states, rootUnavailable };
}

/** Lets every already-queued microtask chain run up to its next real await. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const ROOT = "C:\\work";
const SRC = "C:\\work\\src";
const SRC_NESTED = "C:\\work\\src\\nested";

function context(rootPath: string): WorkContext {
  return {
    id: `workspace-${rootPath}`,
    rootPath,
    canonicalRootPath: rootPath,
    comparisonKey: keyFor(rootPath),
    displayName: displayNameForWorkspaceRoot(rootPath),
  };
}

/** Points the controller at a Workspace and lets its root read finish. */
async function openContext(harness: Harness, rootPath = ROOT): Promise<void> {
  harness.controller.setContext(context(rootPath));
  await flush();
}

/** The directory node at `path`, asserting that it is one. */
function directoryNode(
  controller: ExplorerController,
  path: string,
): ExplorerDirectoryNode {
  const node = controller.getNode(path);
  if (node === null || node.kind !== "directory") {
    throw new Error(`Expected a visible directory at ${path}`);
  }
  return node;
}

/* -------------------------------------------------------------------------- */
/* Workspace features                                                         */
/* -------------------------------------------------------------------------- */

const ROOT_ENTRIES = [
  directory(SRC),
  file("C:\\work\\zeta.txt"),
  file("C:\\work\\Alpha.txt"),
  file("C:\\work\\beta.txt"),
];

describe("ExplorerController context (US1, US2)", () => {
  it("reads only the root when a Workspace becomes active", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });

    await openContext(harness);

    // One directory level, read once: no descendant directory was touched.
    expect(harness.reader.reads).toEqual([ROOT]);
    const root = harness.controller.getState().root;
    expect(root?.loadState).toBe("loaded");
    expect(root?.expanded).toBe(true);
    expect(root?.resolvedCanonicalPath).toBe(ROOT);
    expect(root?.children?.map((child) => child.name)).toEqual([
      "src",
      "Alpha.txt",
      "beta.txt",
      "zeta.txt",
    ]);
  });

  it("sorts directories first and names case-insensitively within a group", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, {
      entries: [
        file("C:\\work\\zeta.txt"),
        directory("C:\\work\\Delta"),
        file("C:\\work\\Alpha.txt"),
        directory("C:\\work\\alpha-dir"),
      ],
    });

    await openContext(harness);

    expect(harness.controller.getState().root?.children?.map((c) => c.name)).toEqual(
      ["alpha-dir", "Delta", "Alpha.txt", "zeta.txt"],
    );
  });

  it("keeps no Workspace state when the context is cleared", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await openContext(harness);

    harness.controller.setContext(null);

    const state = harness.controller.getState();
    expect(state.contextId).toBeNull();
    expect(state.root).toBeNull();
    expect(state.selectedPath).toBeNull();
    expect(state.inlineEdit).toBeNull();
  });

  it("treats the same context id as a no-op and a new one as a rebuild", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    const active = context(ROOT);

    harness.controller.setContext(active);
    await flush();
    harness.controller.selectPath(SRC);
    const readsBefore = harness.reader.reads.length;

    // Reopening the same Workspace keeps the user's selection and expansion.
    harness.controller.setContext(active);
    await flush();
    expect(harness.controller.getSelectedPath()).toBe(SRC);
    expect(harness.reader.reads).toHaveLength(readsBefore);

    // A different Workspace replaces the transient state entirely.
    harness.reader.addDirectory("C:\\other", { entries: [file("C:\\other\\a.txt")] });
    harness.controller.setContext(context("C:\\other"));
    await flush();
    expect(harness.controller.getSelectedPath()).toBeNull();
    expect(harness.controller.getState().root?.path).toBe("C:\\other");
  });
});

/* -------------------------------------------------------------------------- */
/* Lazy loading                                                               */
/* -------------------------------------------------------------------------- */

describe("ExplorerController lazy loading (US2)", () => {
  it("loads a directory's direct children on first expansion only", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [directory(SRC_NESTED)] });
    harness.reader.addDirectory(SRC_NESTED, {
      entries: [file("C:\\work\\src\\nested\\a.ts")],
    });

    await openContext(harness);
    const root = harness.controller.getState().root!;
    const src = root.children![0];

    await harness.controller.expandDirectory(SRC);

    expect(harness.reader.reads).toEqual([ROOT, SRC]);
    const loaded = harness.controller.getNode(SRC)!;
    expect(loaded.kind === "directory" && loaded.loadState).toBe("loaded");
    expect(loaded.kind === "directory" && loaded.children?.length).toBe(1);

    // The grandchild was never read merely because its parent expanded.
    expect(harness.reader.readsFor(SRC_NESTED)).toBe(0);
    expect(src.path).toBe(SRC);
  });

  it("reuses cached children when a loaded directory is collapsed and expanded", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\a.ts")] });
    await openContext(harness);

    await harness.controller.expandDirectory(SRC);
    await harness.controller.toggleDirectory(SRC);
    expect(directoryNode(harness.controller, SRC).expanded).toBe(false);

    await harness.controller.toggleDirectory(SRC);

    // SC-003: collapsing and re-expanding costs no additional read.
    expect(harness.reader.readsFor(SRC)).toBe(1);
    expect(directoryNode(harness.controller, SRC).loadState).toBe("loaded");
  });

  it("caches a load that finished after the user collapsed the directory", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\a.ts")] });
    await openContext(harness);

    harness.reader.hold = true;
    const expanding = harness.controller.expandDirectory(SRC);
    await flush();

    // The user collapses before the read returns.
    await harness.controller.toggleDirectory(SRC);
    harness.reader.releaseAll();
    await expanding;

    const node = harness.controller.getNode(SRC) as {
      expanded: boolean;
      loadState: string;
      children?: readonly unknown[];
    };
    // The result filled the cache without forcing the directory open again.
    expect(node.loadState).toBe("loaded");
    expect(node.children).toHaveLength(1);
    expect(node.expanded).toBe(false);
  });

  it("drops a superseded read of the same directory", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [file("C:\\work\\first.txt")] });
    await openContext(harness);
    expect(
      harness.controller.getState().root?.children?.map((child) => child.name),
    ).toEqual(["first.txt"]);

    // Two reads of the same node, with the older one returning last.
    harness.reader.hold = true;
    const older = harness.controller.loadRoot();
    await flush();
    harness.reader.addDirectory(ROOT, { entries: [file("C:\\work\\second.txt")] });
    const newer = harness.controller.loadRoot();
    await flush();
    expect(harness.reader.pendingReadCount()).toBe(2);

    // The newer read applies first, then the older one completes and must be
    // discarded instead of overwriting the newer listing (FR-030).
    harness.reader.releaseLast();
    await newer;
    harness.reader.releaseNext();
    await older;

    const root = harness.controller.getState().root!;
    expect(root.children?.map((child) => child.name)).toEqual(["second.txt"]);
    expect(root.loadState).toBe("loaded");
  });

  it("keeps a failed load local to its node", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, {
      entries: [directory(SRC), file("C:\\work\\a.txt")],
    });
    harness.reader.failWith(SRC, {
      code: "io_directory",
      message: "Access is denied.",
    });
    await openContext(harness);

    await harness.controller.expandDirectory(SRC);

    const node = harness.controller.getNode(SRC) as {
      loadState: string;
      errorMessage?: string;
    };
    expect(node.loadState).toBe("error");
    expect(node.errorMessage).toBe("Access is denied.");

    // The rest of the Explorer is still usable.
    const root = harness.controller.getState().root!;
    expect(root.loadState).toBe("loaded");
    expect(root.children).toHaveLength(2);
    expect(harness.controller.getState().rootUnavailable).toBe(false);
  });

  it("discards a completion that belongs to a replaced Workspace", async () => {    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\stale.ts")] });
    harness.reader.addDirectory("C:\\other", {
      entries: [file("C:\\other\\fresh.ts")],
    });
    await openContext(harness);

    harness.reader.hold = true;
    const expanding = harness.controller.expandDirectory(SRC);
    await flush();

    // The Workspace is replaced while the old directory read is in flight.
    harness.controller.setContext(context("C:\\other"));
    harness.reader.releaseAll();
    await expanding;
    await flush();

    const state = harness.controller.getState();
    expect(state.root?.path).toBe("C:\\other");
    expect(state.root?.children?.map((child) => child.name)).toEqual([
      "fresh.ts",
    ]);
    // The stale result never appeared under the new Workspace.
    expect(harness.controller.getNode(SRC)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Symlink / junction cycles                                                  */
/* -------------------------------------------------------------------------- */

describe("ExplorerController ancestor cycles (FR-034, SC-013)", () => {
  it("stops a directory link whose canonical target repeats an ancestor", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory("C:\\work\\loop", true)] });
    // The link resolves back to the root itself, which is its own ancestor.
    harness.reader.addDirectory("C:\\work\\loop", {
      entries: [directory("C:\\work\\loop\\src")],
      canonicalPath: ROOT,
      comparisonKey: keyFor(ROOT),
    });
    await openContext(harness);

    await harness.controller.expandDirectory("C:\\work\\loop");

    const node = harness.controller.getNode("C:\\work\\loop") as {
      loadState: string;
      errorMessage?: string;
      children?: readonly unknown[];
    };
    expect(node.loadState).toBe("error");
    expect(node.errorMessage).toBe(DIRECTORY_CYCLE_MESSAGE);
    expect(node.children).toHaveLength(0);
    // The read happened once; nothing further is followed.
    expect(harness.reader.readsFor("C:\\work\\loop")).toBe(1);
  });

  it("stops a deeper cycle against any ancestor, not just the root", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [directory("C:\\work\\src\\up", true)] });
    harness.reader.addDirectory("C:\\work\\src\\up", {
      entries: [],
      canonicalPath: ROOT,
      comparisonKey: keyFor(ROOT),
    });
    await openContext(harness);

    await harness.controller.expandDirectory(SRC);
    await harness.controller.expandDirectory("C:\\work\\src\\up");

    const node = harness.controller.getNode("C:\\work\\src\\up") as {
      loadState: string;
      errorMessage?: string;
    };
    expect(node.loadState).toBe("error");
    expect(node.errorMessage).toBe(DIRECTORY_CYCLE_MESSAGE);
  });

  it("keeps a non-cycling directory link browsable", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, {
      entries: [directory("C:\\work\\link", true), directory("C:\\work\\target")],
    });
    // The link points at a sibling directory, which is not an ancestor.
    harness.reader.addDirectory("C:\\work\\link", {
      entries: [file("C:\\work\\link\\shared.ts")],
      canonicalPath: "C:\\work\\target",
      comparisonKey: keyFor("C:\\work\\target"),
    });
    harness.reader.addDirectory("C:\\work\\target", {
      entries: [file("C:\\work\\target\\shared.ts")],
    });
    await openContext(harness);

    await harness.controller.expandDirectory("C:\\work\\link");

    const node = harness.controller.getNode("C:\\work\\link") as {
      loadState: string;
      children?: readonly { name: string }[];
    };
    // No global visited graph: another branch may still browse the same target.
    expect(node.loadState).toBe("loaded");
    expect(node.children?.map((child) => child.name)).toEqual(["shared.ts"]);

    await harness.controller.expandDirectory("C:\\work\\target");
    expect(
      (harness.controller.getNode("C:\\work\\target") as { loadState: string })
        .loadState,
    ).toBe("loaded");
  });
});

/* -------------------------------------------------------------------------- */
/* Selection and inline editing                                                */
/* -------------------------------------------------------------------------- */

describe("ExplorerController selection and inline editor", () => {
  it("keeps selection independent from expansion and publishing", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await openContext(harness);

    harness.controller.selectPath("C:\\work\\beta.txt");
    expect(harness.controller.getSelectedPath()).toBe("C:\\work\\beta.txt");
    expect(harness.controller.getSelectedNode()?.name).toBe("beta.txt");

    // Re-selecting the same path does not churn state.
    const emissionsBefore = harness.states.length;
    harness.controller.selectPath("C:\\work\\beta.txt");
    expect(harness.states).toHaveLength(emissionsBefore);

    harness.controller.clearSelection();
    expect(harness.controller.getSelectedPath()).toBeNull();
    expect(harness.controller.getSelectedNode()).toBeNull();
  });

  it("runs exactly one inline editor at a time", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await openContext(harness);

    harness.controller.beginCreate("file", SRC);
    expect(harness.controller.getInlineEdit()).toEqual({
      type: "create-file",
      parentPath: SRC,
      draftName: "",
    });

    harness.controller.updateInlineDraft("new.txt");
    expect(harness.controller.getInlineEdit()).toMatchObject({
      draftName: "new.txt",
    });

    // Starting a rename replaces the create editor rather than stacking.
    harness.controller.beginRename("C:\\work\\beta.txt");
    expect(harness.controller.getInlineEdit()).toEqual({
      type: "rename",
      sourcePath: "C:\\work\\beta.txt",
      originalName: "beta.txt",
      draftName: "beta.txt",
    });

    harness.controller.cancelInlineEdit();
    expect(harness.controller.getInlineEdit()).toBeNull();
  });

  it("ignores a rename for a path that is not visible", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await openContext(harness);

    harness.controller.beginRename("C:\\work\\absent.txt");

    expect(harness.controller.getInlineEdit()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Refresh                                                                    */
/* -------------------------------------------------------------------------- */

describe("ExplorerController refresh (US9)", () => {
  function createRefreshedHarness(): Harness {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [directory(SRC_NESTED)] });
    harness.reader.addDirectory(SRC_NESTED, {
      entries: [file("C:\\work\\src\\nested\\deep.ts")],
    });
    return harness;
  }

  it("rereads every loaded directory and leaves never-loaded ones alone", async () => {
    const harness = createRefreshedHarness();
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);

    // `nested` is visible but has never been opened.
    expect(harness.reader.readsFor(SRC_NESTED)).toBe(0);
    const readsBefore = harness.reader.reads.length;

    await harness.controller.refresh();

    expect(harness.reader.reads.slice(readsBefore)).toEqual([ROOT, SRC]);
    expect(harness.reader.readsFor(SRC_NESTED)).toBe(0);
  });

  it("keeps expanded state and selection while applying external changes", async () => {
    const harness = createRefreshedHarness();
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);
    harness.controller.selectPath(SRC);
    harness.controller.beginCreate("file", SRC);

    // Externally, one file appeared and `nested` disappeared.
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\new.ts")] });
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });

    await harness.controller.refresh();

    const src = harness.controller.getNode(SRC) as {
      expanded: boolean;
      loadState: string;
      children?: readonly { name: string }[];
    };
    expect(src.expanded).toBe(true);
    expect(src.loadState).toBe("loaded");
    expect(src.children?.map((child) => child.name)).toEqual(["new.ts"]);
    // The selection still exists, so it survives.
    expect(harness.controller.getSelectedPath()).toBe(SRC);
    // An uncommitted inline edit is cancelled before new state is applied.
    expect(harness.controller.getInlineEdit()).toBeNull();
  });

  it("clears a selection whose path no longer exists", async () => {
    const harness = createRefreshedHarness();
    await openContext(harness);
    harness.controller.selectPath(SRC);

    harness.reader.addDirectory(ROOT, { entries: [file("C:\\work\\other.txt")] });

    await harness.controller.refresh();

    expect(harness.controller.getSelectedPath()).toBeNull();
  });

  it("rereads collapsed-but-loaded directories, not just expanded ones", async () => {
    const harness = createRefreshedHarness();
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);
    await harness.controller.toggleDirectory(SRC);
    expect(harness.reader.readsFor(SRC)).toBe(1);

    await harness.controller.refresh();

    expect(harness.reader.readsFor(SRC)).toBe(2);
  });

  it("reports a refresh failure as a local node error", async () => {
    const harness = createRefreshedHarness();
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);

    // The loaded directory becomes unreadable externally.
    harness.reader.failWith(SRC, {
      code: "io_directory",
      message: "The folder is unavailable.",
    });

    await harness.controller.refresh();

    const src = harness.controller.getNode(SRC) as {
      loadState: string;
      errorMessage?: string;
    };
    expect(src.loadState).toBe("error");
    expect(src.errorMessage).toBe("The folder is unavailable.");
    // The root remains loaded and the Workspace is untouched.
    expect(harness.controller.getState().rootUnavailable).toBe(false);
  });

  it("discards a refresh whose Workspace was replaced mid-flight", async () => {
    const harness = createRefreshedHarness();
    harness.reader.addDirectory("C:\\other", {
      entries: [file("C:\\other\\fresh.ts")],
    });
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);

    harness.reader.hold = true;
    const refreshing = harness.controller.refresh();
    await flush();

    harness.controller.setContext(context("C:\\other"));
    harness.reader.releaseAll();
    await refreshing;
    await flush();

    // Only the new Workspace's root read is reflected.
    const state = harness.controller.getState();
    expect(state.root?.path).toBe("C:\\other");
    expect(state.root?.children?.map((child) => child.name)).toEqual([
      "fresh.ts",
    ]);
    expect(harness.controller.getNode(SRC)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Root availability                                                          */
/* -------------------------------------------------------------------------- */

describe("ExplorerController root availability (FR-088)", () => {
  it("reports an unreadable root without discarding the Workspace", async () => {
    const harness = createHarness();
    harness.reader.failWith(ROOT, {
      code: "io_directory",
      message: "The drive is not ready.",
    });

    await openContext(harness);

    const state = harness.controller.getState();
    expect(state.contextId).not.toBeNull();
    expect(state.rootUnavailable).toBe(true);
    expect(state.root?.loadState).toBe("error");
    expect(state.root?.errorMessage).toBe("The drive is not ready.");
    expect(harness.rootUnavailable).toEqual([true]);
  });

  it("clears the unavailable state when a later refresh succeeds", async () => {
    const harness = createHarness();
    harness.reader.failWith(ROOT, {
      code: "io_directory",
      message: "The drive is not ready.",
    });
    await openContext(harness);
    expect(harness.controller.getState().rootUnavailable).toBe(true);

    // The root becomes readable again and Refresh retries it.
    const readsBefore = harness.reader.readsFor(ROOT);
    harness.reader.clearFailure(ROOT);
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await harness.controller.refresh();

    const state = harness.controller.getState();
    expect(harness.reader.readsFor(ROOT)).toBe(readsBefore + 1);
    expect(state.rootUnavailable).toBe(false);
    expect(state.root?.loadState).toBe("loaded");
    expect(harness.rootUnavailable).toEqual([true, false]);
  });

  it("uses the root context for the Workspace after a failed root read", async () => {
    const harness = createHarness();
    harness.reader.failWith(ROOT, {
      code: "io_directory",
      message: "The drive is not ready.",
    });

    await openContext(harness);

    // The root node still exists, so root-level actions keep a target.
    expect(harness.controller.getState().root?.path).toBe(ROOT);
  });

  it("clears the unavailable state when an open proves the root readable", async () => {
    const harness = createHarness();
    harness.reader.failWith(ROOT, {
      code: "io_directory",
      message: "The drive is not ready.",
    });
    await openContext(harness);
    expect(harness.controller.getState().rootUnavailable).toBe(true);
    expect(harness.controller.getState().root?.loadState).toBe("error");

    // The root is reachable again and the application proves it by reopening the
    // Workspace, so the banner and the error row must not outlive recovery.
    harness.reader.clearFailure(ROOT);
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    harness.controller.markRootAvailable();
    await flush();

    const state = harness.controller.getState();
    expect(state.rootUnavailable).toBe(false);
    expect(state.root?.loadState).toBe("loaded");
    expect(state.root?.children).toHaveLength(ROOT_ENTRIES.length);
  });

  it("keeps a healthy Explorer untouched when the root was never unavailable", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await openContext(harness);
    harness.controller.selectPath(SRC);
    const readsBefore = harness.reader.readsFor(ROOT);

    harness.controller.markRootAvailable();
    await flush();

    // A successful open of an already-healthy Workspace re-reads nothing.
    expect(harness.reader.readsFor(ROOT)).toBe(readsBefore);
    expect(harness.controller.getSelectedPath()).toBe(SRC);
  });
});

/* -------------------------------------------------------------------------- */
/* Mutation reconciliation                                                    */
/* -------------------------------------------------------------------------- */

describe("ExplorerController mutation reconciliation (FR-086)", () => {
  it("inserts a created entry into its parent's cached children", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await openContext(harness);

    harness.controller.applyCreatedEntry(ROOT, file("C:\\work\\created.txt"));

    const names = harness.controller
      .getState()
      .root!.children!.map((child) => child.name);
    expect(names).toEqual(["src", "Alpha.txt", "beta.txt", "created.txt", "zeta.txt"]);
    expect(harness.reader.readsFor(ROOT)).toBe(1);
  });

  it("does not insert an entry whose parent was never loaded", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    await openContext(harness);

    harness.controller.applyCreatedEntry(SRC, file("C:\\work\\src\\a.ts"));

    expect(
      (harness.controller.getNode(SRC) as { loadState: string }).loadState,
    ).toBe("not-loaded");
    expect(harness.controller.getNode("C:\\work\\src\\a.ts")).toBeNull();
  });

  it("rebases a renamed node, its descendants and the selection", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\a.ts")] });
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);
    harness.controller.selectPath("C:\\work\\src\\a.ts");

    harness.controller.applyRenamedEntry({
      sourcePath: SRC,
      newPath: "C:\\work\\lib",
      newName: "lib",
    });

    const renamed = harness.controller.getNode("C:\\work\\lib") as {
      name: string;
      expanded: boolean;
      loadState: string;
      children?: readonly { path: string }[];
    };
    expect(renamed.name).toBe("lib");
    // Expansion and cached children survive the rename.
    expect(renamed.expanded).toBe(true);
    expect(renamed.loadState).toBe("loaded");
    expect(renamed.children?.[0].path).toBe("C:\\work\\lib\\a.ts");
    expect(harness.controller.getNode(SRC)).toBeNull();
    expect(harness.controller.getSelectedPath()).toBe("C:\\work\\lib\\a.ts");
    expect(harness.controller.getState().root?.children?.[0].name).toBe("lib");
  });

  it("removes a deleted node and any selection inside it", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\a.ts")] });
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);
    harness.controller.selectPath("C:\\work\\src\\a.ts");

    harness.controller.applyDeletedEntry(SRC);

    expect(harness.controller.getNode(SRC)).toBeNull();
    expect(harness.controller.getNode("C:\\work\\src\\a.ts")).toBeNull();
    expect(harness.controller.getSelectedPath()).toBeNull();
  });

  it("leaves unrelated nodes alone when a sibling is deleted", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: ROOT_ENTRIES });
    await openContext(harness);

    harness.controller.applyDeletedEntry("C:\\work\\beta.txt");

    expect(harness.controller.getNode("C:\\work\\beta.txt")).toBeNull();
    expect(harness.controller.getNode(SRC)).not.toBeNull();
    expect(harness.controller.getState().root?.children).toHaveLength(3);
  });

  it("keeps a selection in a prefix sibling when a directory is renamed", async () => {
    const harness = createHarness();
    const sibling = "C:\\work\\src2";
    harness.reader.addDirectory(ROOT, {
      entries: [directory(SRC), directory(sibling)],
    });
    harness.reader.addDirectory(sibling, {
      entries: [file("C:\\work\\src2\\c.ts")],
    });
    await openContext(harness);
    await harness.controller.expandDirectory(sibling);
    harness.controller.selectPath("C:\\work\\src2\\c.ts");

    harness.controller.applyRenamedEntry({
      sourcePath: SRC,
      newPath: "C:\\work\\lib",
      newName: "lib",
    });

    // `src2` only shares a name prefix with `src`, so the selection inside it
    // must not be rebased onto the renamed directory (FR-043).
    expect(harness.controller.getSelectedPath()).toBe("C:\\work\\src2\\c.ts");
    expect(harness.controller.getNode("C:\\work\\src2\\c.ts")).not.toBeNull();
  });

  it("keeps a selection in a prefix sibling when a directory is deleted", async () => {
    const harness = createHarness();
    const sibling = "C:\\work\\src2";
    harness.reader.addDirectory(ROOT, {
      entries: [directory(SRC), directory(sibling)],
    });
    harness.reader.addDirectory(sibling, {
      entries: [file("C:\\work\\src2\\c.ts")],
    });
    await openContext(harness);
    await harness.controller.expandDirectory(sibling);
    harness.controller.selectPath("C:\\work\\src2\\c.ts");

    harness.controller.applyDeletedEntry(SRC);

    expect(harness.controller.getSelectedPath()).toBe("C:\\work\\src2\\c.ts");
  });
});
