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
        // These fixtures model the case-insensitive platform this application
        // targets; the pre-mutation comparison contract itself is pinned by the
        // explorer-action tests.
        caseSensitive: false,
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
  return {
    name: leafName(path),
    path,
    kind: "file",
    isSymlink: false,
    objectIdentity: `fake:${keyFor(path)}`,
  };
}

function directory(path: string, isSymlink = false): WorkspaceDirectoryEntry {
  return {
    name: leafName(path),
    path,
    kind: "directory",
    isSymlink,
    objectIdentity: `fake:${keyFor(path)}`,
  };
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

  it("reuses cached children on re-expansion and requests one bounded reconciliation", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\a.ts")] });
    await openContext(harness);

    await harness.controller.expandDirectory(SRC);
    await harness.controller.toggleDirectory(SRC);
    expect(directoryNode(harness.controller, SRC).expanded).toBe(false);
    expect(directoryNode(harness.controller, SRC).children).toHaveLength(1);

    await harness.controller.toggleDirectory(SRC);

    // SR-002 (006): the cached children render immediately — nothing is
    // discarded and no "loading" flicker is introduced — and exactly one
    // bounded direct-child reconciliation is requested on top.
    const node = directoryNode(harness.controller, SRC);
    expect(node.loadState).toBe("loaded");
    expect(node.children).toHaveLength(1);
    expect(node.expanded).toBe(true);

    await harness.controller.whenIdle();
    expect(harness.reader.readsFor(SRC)).toBe(2);
  });

  it("reads a never-loaded directory exactly once on its first expansion", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\a.ts")] });
    await openContext(harness);

    await harness.controller.expandDirectory(SRC);
    await harness.controller.whenIdle();

    expect(harness.reader.readsFor(SRC)).toBe(1);
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

  it("shares one in-flight read for duplicate requests and applies the newest listing once", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [file("C:\\work\\first.txt")] });
    await openContext(harness);
    expect(
      harness.controller.getState().root?.children?.map((child) => child.name),
    ).toEqual(["first.txt"]);

    // Two requests for the same directory while the first read is in flight.
    harness.reader.hold = true;
    const first = harness.controller.loadRoot();
    await flush();
    harness.reader.addDirectory(ROOT, { entries: [file("C:\\work\\second.txt")] });
    const second = harness.controller.loadRoot();
    await flush();

    // FR-018: the duplicate joins the in-flight read instead of launching a
    // parallel one; it merely marks the directory dirty again.
    expect(harness.reader.pendingReadCount()).toBe(1);

    harness.reader.hold = false;
    harness.reader.releaseAll();
    await first;
    await second;
    await harness.controller.whenIdle();

    // FR-019: at most one follow-up read ran, and the final state is the newest
    // filesystem listing rather than the one the first read happened to see.
    const root = harness.controller.getState().root!;
    expect(root.children?.map((child) => child.name)).toEqual(["second.txt"]);
    expect(root.loadState).toBe("loaded");
    expect(harness.reader.readsFor(ROOT)).toBe(3);
  });

  it("prevents an older completion from overwriting a newer explicit read", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\old.ts")] });
    await openContext(harness);
    await harness.controller.expandDirectory(SRC);

    // A held background read of SRC is in flight...
    harness.reader.hold = true;
    const background = harness.controller.reconcileDirectory(SRC, "watcher");
    await flush();

    // ...the user refreshes, and the disk now holds something newer.
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\new.ts")] });
    const refreshing = harness.controller.refresh();
    await flush();

    harness.reader.hold = false;
    harness.reader.releaseAll();
    await background;
    await refreshing;
    await harness.controller.whenIdle();

    const node = directoryNode(harness.controller, SRC);
    expect(node.children?.map((child) => child.name)).toEqual(["new.ts"]);
    expect(node.loadState).toBe("loaded");
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
/* Interaction state during reconciliation (006 US6)                           */
/* -------------------------------------------------------------------------- */

/** An entry with an explicit object token, so continuity can be proven. */
function withIdentity(
  entry: WorkspaceDirectoryEntry,
  objectIdentity: string | null,
): WorkspaceDirectoryEntry {
  return { ...entry, objectIdentity };
}

describe("ExplorerController interaction state (006 US6)", () => {
  async function openRootWith(
    harness: Harness,
    entries: readonly WorkspaceDirectoryEntry[],
  ): Promise<void> {
    harness.reader.addDirectory(ROOT, { entries: [...entries] });
    await openContext(harness);
  }

  it("preserves selection, expansion and an unrelated inline draft", async () => {
    const harness = createHarness();
    await openRootWith(harness, [directory(SRC), file("C:\\work\\beta.txt")]);
    await harness.controller.expandDirectory(SRC);
    harness.controller.selectPath(SRC);
    harness.controller.beginRename("C:\\work\\beta.txt");

    // An unrelated external creation in the same directory.
    harness.reader.addDirectory(ROOT, {
      entries: [
        directory(SRC),
        file("C:\\work\\beta.txt"),
        file("C:\\work\\gamma.txt"),
      ],
    });
    await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(harness.controller.getSelectedPath()).toBe(SRC);
    expect(directoryNode(harness.controller, SRC).expanded).toBe(true);
    // FR-088: background reconciliation never cancels an unrelated draft.
    expect(harness.controller.getInlineEdit()).toMatchObject({
      type: "rename",
      sourcePath: "C:\\work\\beta.txt",
    });
    expect(
      harness.controller.getNode("C:\\work\\gamma.txt"),
    ).not.toBeNull();
  });

  it("clears the selection when the selected node is externally deleted", async () => {
    const harness = createHarness();
    await openRootWith(harness, [directory(SRC), file("C:\\work\\beta.txt")]);
    harness.controller.selectPath("C:\\work\\beta.txt");

    harness.reader.addDirectory(ROOT, { entries: [directory(SRC)] });
    await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(harness.controller.getSelectedPath()).toBeNull();
    expect(harness.controller.getNode("C:\\work\\beta.txt")).toBeNull();
  });

  it("cancels an inline rename whose target was externally replaced", async () => {
    const harness = createHarness();
    await openRootWith(harness, [
      withIdentity(file("C:\\work\\beta.txt"), "obj:old"),
    ]);
    harness.controller.beginRename("C:\\work\\beta.txt");

    // The path exists, but it is a *different* filesystem object.
    harness.reader.addDirectory(ROOT, {
      entries: [withIdentity(file("C:\\work\\beta.txt"), "obj:new")],
    });
    await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(harness.controller.getInlineEdit()).toBeNull();
  });

  it("cancels an inline create whose parent directory disappeared", async () => {
    const harness = createHarness();
    await openRootWith(harness, [directory(SRC)]);
    await harness.controller.expandDirectory(SRC);
    harness.controller.beginCreate("file", SRC);

    harness.reader.addDirectory(ROOT, { entries: [] });
    await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(harness.controller.getInlineEdit()).toBeNull();
  });

  it("follows a confirmed external rename for the selection and the cache", async () => {
    const harness = createHarness();
    const MOVED = "C:\\work\\lib";
    await openRootWith(harness, [
      withIdentity(directory(SRC), "obj:src"),
      withIdentity(file("C:\\work\\beta.txt"), "obj:beta"),
    ]);
    harness.reader.addDirectory(SRC, {
      entries: [withIdentity(file("C:\\work\\src\\a.ts"), "obj:a")],
    });
    await harness.controller.expandDirectory(SRC);
    harness.controller.selectPath("C:\\work\\src\\a.ts");

    // The directory keeps its object identity, so the move is provable.
    harness.reader.addDirectory(ROOT, {
      entries: [
        withIdentity(directory(MOVED), "obj:src"),
        withIdentity(file("C:\\work\\beta.txt"), "obj:beta"),
      ],
    });
    const result = await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(result.relocations).toEqual([
      {
        kind: "directory",
        oldPath: SRC,
        newPath: MOVED,
        objectIdentity: "obj:src",
      },
    ]);
    // FR-044/FR-085: the cached subtree follows the node and the selection is
    // rebased with its descendant suffix, without any directory read.
    expect(harness.controller.getNode(SRC)).toBeNull();
    const moved = directoryNode(harness.controller, MOVED);
    expect(moved.expanded).toBe(true);
    expect(moved.children?.map((child) => child.path)).toEqual([
      "C:\\work\\lib\\a.ts",
    ]);
    expect(harness.controller.getSelectedPath()).toBe("C:\\work\\lib\\a.ts");
    expect(harness.reader.readsFor(MOVED)).toBe(0);
  });

  it("keeps two logical positions that reach one object as separate nodes", async () => {
    const harness = createHarness();
    const FIRST = "C:\\work\\first-link";
    const SECOND = "C:\\work\\second-link";
    await openRootWith(harness, [
      withIdentity(directory(FIRST, true), "obj:shared"),
      withIdentity(directory(SECOND, true), "obj:shared"),
    ]);
    // Both links resolve to one directory outside the Workspace root.
    for (const link of [FIRST, SECOND]) {
      harness.reader.addDirectory(link, {
        entries: [withIdentity(file(`${link}\\shared.ts`), "obj:file")],
        canonicalPath: "D:\\outside",
        comparisonKey: keyFor("D:\\outside"),
      });
    }

    await harness.controller.expandDirectory(FIRST);
    await harness.controller.expandDirectory(SECOND);
    await harness.controller.reconcileDirectory(ROOT, "watcher");

    // FR-047/FR-090: identity never deduplicates logical Tree positions.
    expect(harness.controller.getNode(FIRST)).not.toBeNull();
    expect(harness.controller.getNode(SECOND)).not.toBeNull();
    expect(directoryNode(harness.controller, FIRST).children).toHaveLength(1);
    expect(directoryNode(harness.controller, SECOND).children).toHaveLength(1);
  });

  it("lists an expanded link by its logical path for periodic reconciliation", async () => {
    const harness = createHarness();
    const LINK = "C:\\work\\link";
    await openRootWith(harness, [withIdentity(directory(LINK, true), "obj:link")]);
    harness.reader.addDirectory(LINK, {
      entries: [withIdentity(file("C:\\work\\link\\a.ts"), "obj:a")],
      canonicalPath: "D:\\outside",
      comparisonKey: keyFor("D:\\outside"),
    });

    await harness.controller.expandDirectory(LINK);

    // FR-091/FR-115: the *logical* path is the target, even though the physical
    // target lies outside the Workspace root and outside its watch.
    expect(harness.controller.listExpandedDirectoryPaths()).toEqual([
      ROOT,
      LINK,
    ]);
  });

  it("updates the displayed casing of a case-only external rename", async () => {
    const harness = createHarness();
    await openRootWith(harness, [
      withIdentity(file("C:\\work\\foo.ts"), "obj:1"),
    ]);

    // Windows compares paths case-insensitively, so the canonical key is the
    // same before and after; only the object token proves continuity and only
    // the listing carries the new spelling (FR-046).
    harness.reader.addDirectory(ROOT, {
      entries: [withIdentity(file("C:\\work\\Foo.ts"), "obj:1")],
    });
    const result = await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(result.relocations).toEqual([
      {
        kind: "file",
        oldPath: "C:\\work\\foo.ts",
        newPath: "C:\\work\\Foo.ts",
        objectIdentity: "obj:1",
      },
    ]);
    const renamed = harness.controller.getNode("C:\\work\\Foo.ts");
    expect(renamed?.name).toBe("Foo.ts");
    expect(harness.controller.getNode("C:\\work\\foo.ts")).toBeNull();
  });

  it("drops a descendant read whose parent was removed first", async () => {
    const harness = createHarness();
    await openRootWith(harness, [directory(SRC)]);
    harness.reader.addDirectory(SRC, { entries: [directory(SRC_NESTED)] });
    await harness.controller.expandDirectory(SRC);

    // A lazy read of the grandchild is in flight...
    harness.reader.hold = true;
    const nestedRead = harness.controller.expandDirectory(SRC_NESTED);
    await flush();

    // ...the whole parent subtree disappears on disk, and the parent is
    // reconciled before the descendant read returns (FR-024, FR-107).
    harness.reader.hold = false;
    harness.reader.addDirectory(ROOT, { entries: [] });
    await harness.controller.reconcileDirectory(ROOT, "watcher");
    harness.reader.releaseAll();
    await nestedRead;
    await harness.controller.whenIdle();

    // The stale completion could not repopulate the removed subtree.
    expect(harness.controller.getNode(SRC)).toBeNull();
    expect(harness.controller.getNode(SRC_NESTED)).toBeNull();
  });

  it("reports the represented root and directory query surface", async () => {
    const harness = createHarness();
    await openRootWith(harness, [directory(SRC)]);
    harness.reader.addDirectory(SRC, { entries: [file("C:\\work\\src\\a.ts")] });
    await harness.controller.expandDirectory(SRC);

    expect(harness.controller.getRepresentedRootPath()).toBe(ROOT);
    expect(harness.controller.isDirectoryRepresented(SRC)).toBe(true);
    expect(harness.controller.isDirectoryLoaded(SRC)).toBe(true);
    expect(harness.controller.isDirectoryRepresented(SRC_NESTED)).toBe(false);
    expect(harness.controller.isDirectoryLoaded(SRC_NESTED)).toBe(false);

    // A never-loaded directory is never reconciled by a background request.
    const readsBefore = harness.reader.reads.length;
    await harness.controller.reconcileDirectory(SRC_NESTED, "watcher");
    expect(harness.reader.reads).toHaveLength(readsBefore);
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
    // The condition is projected by the panel-level notice, not by a raw
    // filesystem message on the root row (FR-095).
    expect(state.root?.errorMessage).toBeUndefined();
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

describe("ExplorerController root identity (006 FR-097)", () => {
  it("does not adopt a root path that now resolves somewhere else", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, {
      entries: [file("C:\\work\\a.txt")],
    });
    await openContext(harness);
    expect(harness.controller.getState().rootUnavailable).toBe(false);

    // The same spelling now names a different canonical directory: the root was
    // moved and a junction was re-pointed at it. 006 must not follow that.
    harness.reader.addDirectory(ROOT, {
      entries: [file("C:\\work\\elsewhere.txt")],
      canonicalPath: "D:\\other",
      comparisonKey: keyFor("D:\\other"),
    });
    await harness.controller.loadRoot();
    await harness.controller.whenIdle();

    const state = harness.controller.getState();
    expect(state.rootUnavailable).toBe(true);
    expect(state.root?.loadState).toBe("error");
    // The root's condition is projected once, at panel level: a node-level
    // message inside the Tree would duplicate it and collide with the rows.
    expect(state.root?.errorMessage).toBeUndefined();
    expect(harness.rootUnavailable).toContain(true);
    // The previous children were not replaced by the other directory's.
    expect(state.root?.children?.map((child) => child.name)).toEqual(["a.txt"]);
  });

  it("keeps a failed root read out of the Tree and localizes a child failure", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, {
      entries: [directory(SRC), file("C:\\work\\a.txt")],
    });
    await openContext(harness);
    expect(harness.controller.getState().root?.children).toHaveLength(2);

    // The whole Workspace disappears on disk (moved away or deleted).
    harness.reader.failWith(ROOT, {
      code: "io_directory",
      message:
        "Cannot read directory C:\\work: 系统找不到指定的文件。 (os error 2)",
    });
    await harness.controller.loadRoot();
    await harness.controller.whenIdle();

    const state = harness.controller.getState();
    expect(state.rootUnavailable).toBe(true);
    expect(state.root?.loadState).toBe("error");
    // No raw filesystem message on the root row; the panel notice is the surface
    // and Refresh/periodic retries remain the recovery path (FR-095).
    expect(state.root?.errorMessage).toBeUndefined();
    // Cached children survive: an unreadable root is not a confirmed deletion.
    expect(state.root?.children?.map((child) => child.name)).toEqual([
      "src",
      "a.txt",
    ]);

    // A *non-root* failure stays localized to its own node (FR-025).
    harness.reader.failWith(SRC, {
      code: "io_directory",
      message: "Access is denied.",
    });
    await harness.controller.expandDirectory(SRC);

    const src = harness.controller.getNode(SRC) as {
      loadState: string;
      errorMessage?: string;
    };
    expect(src.loadState).toBe("error");
    expect(src.errorMessage).toBe("Access is denied.");
    // The root is still unavailable, and still carries no message of its own.
    expect(harness.controller.getState().root?.errorMessage).toBeUndefined();
  });

  it("recovers when the original root resolves to its own identity again", async () => {
    const harness = createHarness();
    harness.reader.addDirectory(ROOT, { entries: [file("C:\\work\\a.txt")] });
    await openContext(harness);

    harness.reader.addDirectory(ROOT, {
      entries: [],
      canonicalPath: "D:\\other",
      comparisonKey: keyFor("D:\\other"),
    });
    await harness.controller.loadRoot();
    expect(harness.controller.getState().rootUnavailable).toBe(true);

    // The original directory is restored at its original path.
    harness.reader.addDirectory(ROOT, {
      entries: [file("C:\\work\\a.txt"), file("C:\\work\\b.txt")],
    });
    await harness.controller.loadRoot();
    await harness.controller.whenIdle();

    const state = harness.controller.getState();
    expect(state.rootUnavailable).toBe(false);
    expect(state.root?.loadState).toBe("loaded");
    expect(state.root?.children?.map((child) => child.name)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });
});

/**
 * Opens a Workspace whose root holds exactly `entries`.
 *
 * Module-level so the late 006 interaction-state cases share one fixture setup
 * with the interaction-state describe.
 */
async function openRootWith(
  harness: Harness,
  entries: readonly WorkspaceDirectoryEntry[],
): Promise<void> {
  harness.reader.addDirectory(ROOT, { entries: [...entries] });
  await openContext(harness);
}

describe("ExplorerController inline editor across relocation (FR-087, FR-088)", () => {
  it("cancels an inline rename whose own target was relocated", async () => {
    const harness = createHarness();
    await openRootWith(harness, [
      withIdentity(file("C:\\work\\beta.txt"), "obj:beta"),
    ]);
    harness.controller.beginRename("C:\\work\\beta.txt");
    expect(harness.controller.getInlineEdit()).not.toBeNull();

    // The very entry being renamed moved: rebasing the draft would let a commit
    // rename a path the user never chose, so the edit is cancelled before the new
    // structure is applied (FR-087, US6-AC5).
    harness.reader.addDirectory(ROOT, {
      entries: [withIdentity(file("C:\\work\\moved.txt"), "obj:beta")],
    });
    const result = await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(result.relocations).toHaveLength(1);
    expect(harness.controller.getInlineEdit()).toBeNull();
    expect(harness.controller.getNode("C:\\work\\moved.txt")).not.toBeNull();
  });

  it("follows a relocated parent for an inline create draft", async () => {
    const harness = createHarness();
    await openRootWith(harness, [
      withIdentity(directory(SRC), "obj:src"),
    ]);
    harness.reader.addDirectory(SRC, { entries: [] });
    await harness.controller.expandDirectory(SRC);
    harness.controller.beginCreate("file", SRC);

    // Only the directory the entry will be created in moved, so the draft is
    // still valid under the new path (FR-088).
    const MOVED = "C:\\work\\lib";
    harness.reader.addDirectory(ROOT, {
      entries: [withIdentity(directory(MOVED), "obj:src")],
    });
    await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(harness.controller.getInlineEdit()).toEqual({
      type: "create-file",
      parentPath: MOVED,
      draftName: "",
    });
  });
});

describe("ExplorerController bounded sweep over hundreds of loaded directories (T085, T142)", () => {
  it("returns only the root and the currently expanded directories", async () => {
    const harness = createHarness();
    const MANY = Array.from({ length: 200 }, (_unused, index) =>
      `C:\\work\\pkg-${String(index).padStart(3, "0")}`,
    );
    harness.reader.addDirectory(ROOT, {
      entries: MANY.map((path) => directory(path)),
    });
    await openContext(harness);

    // Hundreds of loaded-but-collapsed directories: each is read once, then
    // collapsed again, so cached history exists without being part of the sweep.
    for (const path of MANY) {
      harness.reader.addDirectory(path, { entries: [file(`${path}\\index.ts`)] });
      await harness.controller.expandDirectory(path);
      await harness.controller.toggleDirectory(path);
    }

    const EXPANDED = MANY.slice(0, 3);
    for (const path of EXPANDED) {
      await harness.controller.expandDirectory(path);
    }
    await harness.controller.whenIdle();

    const paths = harness.controller.listExpandedDirectoryPaths();

    expect(paths[0]).toBe(ROOT);
    expect(paths).toHaveLength(4);
    expect(new Set(paths)).toEqual(new Set([ROOT, ...EXPANDED]));
    for (const collapsed of MANY.slice(3)) {
      expect(paths).not.toContain(collapsed);
      // Loaded, just not expanded.
      expect(harness.controller.isDirectoryLoaded(collapsed)).toBe(true);
    }
  });
});

  it("does not sweep below a collapsed ancestor but restores it on re-expansion", async () => {
    const harness = createHarness();
    const INNER = "C:\\work\\outer";
    const DEEP = "C:\\work\\outer\\deep";
    harness.reader.addDirectory(ROOT, { entries: [directory(INNER)] });
    harness.reader.addDirectory(INNER, { entries: [directory(DEEP)] });
    harness.reader.addDirectory(DEEP, {
      entries: [file("C:\\work\\outer\\deep\\c.ts")],
    });
    await openContext(harness);
    await harness.controller.expandDirectory(INNER);
    await harness.controller.expandDirectory(DEEP);
    expect(harness.controller.listExpandedDirectoryPaths()).toEqual([
      ROOT,
      INNER,
      DEEP,
    ]);

    // Collapsing the ancestor hides the whole subtree: the hidden descendant must
    // not be swept by periodic/recovery work even though it was expanded before
    // (FR-074, US4-AC3).
    await harness.controller.toggleDirectory(INNER);
    expect(harness.controller.listExpandedDirectoryPaths()).toEqual([ROOT]);
    expect(new Set(harness.controller.listExpandedDirectoryPaths())).not.toContain(
      DEEP,
    );
    // Its own expansion state is remembered, not discarded.
    const deep = harness.controller.getNode(DEEP) as { expanded: boolean };
    expect(deep.expanded).toBe(true);

    // Re-expanding the ancestor puts it back in the sweep, without a re-read of
    // the hidden level being needed for that.
    await harness.controller.expandDirectory(INNER);
    expect(harness.controller.listExpandedDirectoryPaths()).toEqual([
      ROOT,
      INNER,
      DEEP,
    ]);
  });

describe("ExplorerController identity-less replacement (T145)", () => {
  it("gives a same-path identity-less entry a fresh node with no inherited state", async () => {
    const harness = createHarness();
    const IDENTITY_LESS = "C:\\work\\pkg";
    harness.reader.addDirectory(ROOT, {
      entries: [withIdentity(directory(IDENTITY_LESS), null)],
    });
    harness.reader.addDirectory(IDENTITY_LESS, {
      entries: [file("C:\\work\\pkg\\old.ts")],
    });
    await openContext(harness);

    await harness.controller.expandDirectory(IDENTITY_LESS);
    const before = harness.controller.getNode(IDENTITY_LESS) as ExplorerDirectoryNode;
    expect(before.children).toHaveLength(1);
    expect(before.expanded).toBe(true);

    harness.controller.selectPath("C:\\work\\pkg\\old.ts");
    harness.controller.beginRename("C:\\work\\pkg\\old.ts");

    // The very same path reappears in the listing with no identity to prove it is
    // still the same directory: the old node, its cache and the interaction state
    // that pointed into it must not be inherited (FR-034, FR-042).
    harness.reader.addDirectory(ROOT, {
      entries: [withIdentity(directory(IDENTITY_LESS), null)],
    });
    const result = await harness.controller.reconcileDirectory(ROOT, "watcher");

    expect(result.removedPaths).toEqual([IDENTITY_LESS]);
    expect(result.addedPaths).toEqual([IDENTITY_LESS]);

    const after = harness.controller.getNode(IDENTITY_LESS) as ExplorerDirectoryNode;
    expect(after).not.toBe(before);
    expect(after.children).toBeUndefined();
    expect(after.loadState).toBe("not-loaded");
    expect(after.expanded).toBe(false);
    // Selection and the inline rename both pointed into the replaced node.
    expect(harness.controller.getSelectedPath()).toBeNull();
    expect(harness.controller.getInlineEdit()).toBeNull();
  });
});
